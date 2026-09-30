/*
 * MCP Handler — Model Context Protocol (Streamable HTTP)
 *
 * 实现 JSON-RPC 2.0 over HTTP，支持以下方法：
 *   - initialize:        握手，返回服务器信息和能力
 *   - tools/list:        返回可用工具列表
 *   - tools/call:        执行工具，返回结果
 *
 * 工具：
 *   - get_recent_touches: 获取最近N分钟的触摸记录（触摸玩偶，原有功能）
 *   - get_last_touch:    获取最近一次触摸详情（触摸玩偶，原有功能）
 *   - ximi_*:            读写西米时间日志/事项待办（新增，见下方"ximi工具"分区）
 *
 * 协议版本：2025-06-18（兼容 Claude 自定义连接器）
 */

const { createClient } = require('@supabase/supabase-js');

// 支持的协议版本
const PROTOCOL_VERSION = '2025-06-18';

// ============ ximi 工具：Supabase 客户端 + 鉴权 ============
// 故意不走 server.js 传进来的 context（那个是给 history/latestTouchSummary/
// touchState 这套触摸玩偶状态用的），独立初始化，两套逻辑不搅在一起。
// 连的是 ximi app 自己那个 Supabase 项目（time_logs/time_categories/
// todo_items 这些表真正在的那个，不是空的那个），项目的 URL/anon key
// 直接复用 ximi 仓库 .env 里 EXPO_PUBLIC_SUPABASE_URL/
// EXPO_PUBLIC_SUPABASE_ANON_KEY 的值即可——RLS本来就是关的，不需要另外
// 申请更高权限的 key。
const XIMI_SUPABASE_URL = process.env.XIMI_SUPABASE_URL;
const XIMI_SUPABASE_ANON_KEY = process.env.XIMI_SUPABASE_ANON_KEY;
const ximiSupabase = (XIMI_SUPABASE_URL && XIMI_SUPABASE_ANON_KEY)
  ? createClient(XIMI_SUPABASE_URL, XIMI_SUPABASE_ANON_KEY)
  : null;

// /mcp 端点现在裸奔（oauth-helper.js 是自动批准的假OAuth，见文件头注释），
// 谁都能连上调用。新增的 ximi 工具能读到/写西米的真实时间日志和事项，必须
// 单独校验一个密钥，不能"复用现有鉴权"（现有鉴权等于没有）。
//
// 密钥有两条路都认，任一条对得上就放行：
//   1. 连接器URL本身带上 ?key=xxx（比如 https://.../mcp?key=xxx）——这个是
//      推荐用法，西米在claude.ai加连接器的时候配一次连接地址就行，之后每次
//      调用密钥都是连接器自动带上的、不需要她在对话里手动教Claude、也不
//      依赖Claude"记不记得住"这种不可靠的东西。server.js 从请求URL上把这个
//      query参数摘出来放进 context.urlAccessKey。
//   2. 工具调用参数里带 access_key（inputSchema里定义的那个字段）——这是给
//      Claude在知道密钥的情况下（比如西米在对话里直接告诉它）也能用的备用
//      路径，两条路径二选一即可。
// 密钥本身通过环境变量配置，不写死在代码里；环境变量没配的话默认拒绝
// （fail closed，不能因为没配置就裸奔放行）。
const XIMI_MCP_ACCESS_KEY = process.env.XIMI_MCP_ACCESS_KEY;

function checkXimiAccess(args, context) {
  if (!XIMI_MCP_ACCESS_KEY) return false;
  const provided = (context && context.urlAccessKey) || (args && args.access_key);
  return provided === XIMI_MCP_ACCESS_KEY;
}

function accessDenied() {
  return {
    isError: true,
    content: [{ type: 'text', text: '密钥不对或没提供，拒绝访问 ximi 相关数据。' }],
  };
}

function noDb() {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: '服务器还没配置 Supabase 连接（XIMI_SUPABASE_URL / XIMI_SUPABASE_ANON_KEY 环境变量），联系西米配一下。',
    }],
  };
}

function dbError(e) {
  console.error('[ximi mcp] 数据库操作失败:', e);
  return {
    isError: true,
    content: [{ type: 'text', text: '数据库操作失败: ' + (e && e.message ? e.message : String(e)) }],
  };
}

// ============ ximi 工具：北京时间安全的日期计算 ============
// 服务器跑在阿里云，进程本身的时区不确定（很可能是UTC），不能直接用
// new Date()的本地getter算"今天"，会因为服务器时区跟北京时区不一致而错位。
// 统一用"Date.now()的UTC毫秒数 + 固定8小时偏移"这套算法，不依赖进程时区
// 设置——中国没有夏令时，+8是常年固定偏移，可以放心写死。
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

function bjNow() {
  return new Date(Date.now() + BJ_OFFSET_MS);
}
function toDateKeyFromBjDate(bjDate) {
  const y = bjDate.getUTCFullYear();
  const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bjDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function todayBjDateKey() {
  return toDateKeyFromBjDate(bjNow());
}
/** 北京时间某一天(date类型的'YYYY-MM-DD')对应的UTC时间范围[start,end)，查time_logs这类timestamptz字段用 */
function bjDateKeyToUtcRange(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - BJ_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}
/** 纯日期值(date类型)转成一个"日历Date"，只用来做年/月/日/星期几的计算，不代表任何具体时刻 */
function parseDateKeyToCalendarDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function lastDayOfMonthUtc(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

// ============ ximi 工具：事项重复规则判断 ============
// 跟 ximi 仓库 lib/todo.ts 的 occursOnDate/isDoneOnDate 语义完全一致——两个
// 仓库各自独立部署，没有代码共享的路子，这里照抄一份等价逻辑。
// repeat_weekdays: 0=周日...6=周六（JS Date.getDay()/getUTCDay()约定）；
// repeat_day_of_month: 1-31，0表示"最后一天"。
function occursOnDate(item, dateKey) {
  const anchor = parseDateKeyToCalendarDate(item.date);
  const d = parseDateKeyToCalendarDate(dateKey);
  if (d.getTime() < anchor.getTime()) return false;
  switch (item.repeat_type) {
    case 'none':
      return d.getTime() === anchor.getTime();
    case 'daily':
      return true;
    case 'weekly':
      return Array.isArray(item.repeat_weekdays) && item.repeat_weekdays.includes(d.getUTCDay());
    case 'monthly': {
      const target = item.repeat_day_of_month === 0
        ? lastDayOfMonthUtc(d.getUTCFullYear(), d.getUTCMonth())
        : (item.repeat_day_of_month != null ? item.repeat_day_of_month : anchor.getUTCDate());
      return d.getUTCDate() === target;
    }
    default:
      return false;
  }
}
function isDoneOnDate(item, dateKey, completions) {
  if (item.repeat_type === 'none') return !!item.done;
  return completions.some((c) => c.todo_id === item.id && c.date === dateKey);
}

// ============ ximi 工具：分类/标签名字匹配 ============
// 匹配不上不新建，调用方(下面每个ximi_*函数)自己决定怎么兜底（一般是把
// 原话记进description/content提醒西米自己看），这里只负责"能不能找到"。
function matchByName(list, name) {
  if (!name) return null;
  const norm = String(name).trim().toLowerCase();
  return list.find((item) => item.name.trim().toLowerCase() === norm) || null;
}
async function fetchTimeCategories() {
  if (!ximiSupabase) return [];
  const { data, error } = await ximiSupabase.from('time_categories').select('id,name').eq('archived', false);
  if (error) throw error;
  return data || [];
}
async function fetchTimeTags() {
  if (!ximiSupabase) return [];
  const { data, error } = await ximiSupabase.from('time_tags').select('id,name').eq('archived', false);
  if (error) throw error;
  return data || [];
}
async function fetchTodoCategories() {
  if (!ximiSupabase) return [];
  const { data, error } = await ximiSupabase.from('todo_categories').select('id,name').eq('archived', false);
  if (error) throw error;
  return data || [];
}

// ============ ximi 工具：具体实现 ============

async function ximiGetLogsForDate(dateKey, { onlyIncompleteTodos }) {
  const { startUtc, endUtc } = bjDateKeyToUtcRange(dateKey);
  const [logsRes, categories, tags, todoItemsRes, todoCategories, completionsRes] = await Promise.all([
    ximiSupabase.from('time_logs').select('*').lt('start_time', endUtc.toISOString()).gt('end_time', startUtc.toISOString()).order('start_time'),
    fetchTimeCategories(),
    fetchTimeTags(),
    ximiSupabase.from('todo_items').select('*').lte('date', dateKey),
    fetchTodoCategories(),
    ximiSupabase.from('todo_completions').select('*').eq('date', dateKey),
  ]);
  if (logsRes.error) throw logsRes.error;
  if (todoItemsRes.error) throw todoItemsRes.error;
  if (completionsRes.error) throw completionsRes.error;

  const catById = {};
  for (const c of categories) catById[c.id] = c.name;
  const tagById = {};
  for (const t of tags) tagById[t.id] = t.name;
  const todoCatById = {};
  for (const c of todoCategories) todoCatById[c.id] = c.name;

  const logs = (logsRes.data || []).map((l) => ({
    id: l.id,
    category: l.category_id ? (catById[l.category_id] || null) : null,
    start_time: l.start_time,
    end_time: l.end_time,
    description: l.description,
    tags: (l.tag_ids || []).map((id) => tagById[id]).filter(Boolean),
  }));

  const completions = completionsRes.data || [];
  let todos = (todoItemsRes.data || [])
    .filter((item) => occursOnDate(item, dateKey))
    .map((item) => ({
      id: item.id,
      content: item.content,
      category: item.category_id ? (todoCatById[item.category_id] || null) : null,
      important: item.important,
      done: isDoneOnDate(item, dateKey, completions),
      repeat_type: item.repeat_type,
    }));
  if (onlyIncompleteTodos) todos = todos.filter((t) => !t.done);

  const text = `${dateKey} 的时间日志共 ${logs.length} 条，事项${onlyIncompleteTodos ? '（未完成）' : ''}共 ${todos.length} 条。`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { date: dateKey, time_logs: logs, todo_items: todos },
  };
}

async function ximiGetToday() {
  if (!ximiSupabase) return noDb();
  return ximiGetLogsForDate(todayBjDateKey(), { onlyIncompleteTodos: true });
}

async function ximiGetDailyLogs(args) {
  if (!ximiSupabase) return noDb();
  const dateKey = args && args.date;
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return { isError: true, content: [{ type: 'text', text: 'date 参数格式不对，要 YYYY-MM-DD' }] };
  }
  return ximiGetLogsForDate(dateKey, { onlyIncompleteTodos: false });
}

async function ximiGetWeeklySummary() {
  if (!ximiSupabase) return noDb();
  const endDateKey = todayBjDateKey();
  const { endUtc } = bjDateKeyToUtcRange(endDateKey);
  const startDateKey = toDateKeyFromBjDate(new Date(bjNow().getTime() - 6 * 24 * 60 * 60 * 1000));
  const { startUtc } = bjDateKeyToUtcRange(startDateKey);

  const [logsRes, categories] = await Promise.all([
    ximiSupabase.from('time_logs').select('category_id,start_time,end_time').lt('start_time', endUtc.toISOString()).gt('end_time', startUtc.toISOString()),
    fetchTimeCategories(),
  ]);
  if (logsRes.error) throw logsRes.error;
  const catById = {};
  for (const c of categories) catById[c.id] = c.name;

  const rangeStartMs = startUtc.getTime();
  const rangeEndMs = endUtc.getTime();
  let totalMinutes = 0;
  const byCat = {};
  for (const log of logsRes.data || []) {
    const s = Math.max(new Date(log.start_time).getTime(), rangeStartMs);
    const e = Math.min(new Date(log.end_time).getTime(), rangeEndMs);
    const minutes = Math.max(0, (e - s) / 60000);
    if (minutes <= 0) continue;
    totalMinutes += minutes;
    const key = log.category_id ? (catById[log.category_id] || '未知分类') : '未分类';
    byCat[key] = (byCat[key] || 0) + minutes;
  }
  const byCategory = Object.entries(byCat)
    .map(([name, minutes]) => ({
      category_name: name,
      minutes: Math.round(minutes),
      percent: totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes);

  const text = `最近7天（${startDateKey} ~ ${endDateKey}）总共记录了 ${Math.round(totalMinutes)} 分钟，按分类占比：\n` +
    (byCategory.length > 0 ? byCategory.map((c) => `${c.category_name}: ${c.minutes}分钟（${c.percent}%）`).join('\n') : '（没有记录）');

  return {
    content: [{ type: 'text', text }],
    structuredContent: { rangeStart: startDateKey, rangeEnd: endDateKey, totalMinutes: Math.round(totalMinutes), byCategory },
  };
}

async function ximiLogTime(args) {
  if (!ximiSupabase) return noDb();
  const entries = Array.isArray(args && args.entries) ? args.entries : [];
  if (entries.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'entries 不能是空数组' }] };
  }
  for (const e of entries) {
    if (!e || !e.start_time || !e.end_time) {
      return { isError: true, content: [{ type: 'text', text: '每条 entry 都必须有 start_time 和 end_time' }] };
    }
  }

  const [categories, tags] = await Promise.all([fetchTimeCategories(), fetchTimeTags()]);

  const rows = [];
  const notes = [];
  for (const e of entries) {
    let categoryId = null;
    let description = e.description || null;
    if (e.category_name) {
      const matched = matchByName(categories, e.category_name);
      if (matched) {
        categoryId = matched.id;
      } else {
        description = `[原分类: ${e.category_name}] ${description || ''}`.trim();
        notes.push(`"${e.category_name}" 没匹配到已有分类，没有新建分类，已经把原话记进描述里了`);
      }
    }
    const tagIds = [];
    if (Array.isArray(e.tag_names)) {
      for (const tn of e.tag_names) {
        const matched = matchByName(tags, tn);
        if (matched) tagIds.push(matched.id);
      }
    }
    rows.push({
      category_id: categoryId,
      start_time: e.start_time,
      end_time: e.end_time,
      description,
      tag_ids: tagIds,
      source: 'chat',
    });
  }

  const { data, error } = await ximiSupabase.from('time_logs').insert(rows).select();
  if (error) throw error;

  const text = `已经写入 ${data.length} 条时间记录。` + (notes.length > 0 ? '\n' + notes.join('\n') : '');
  return {
    content: [{ type: 'text', text }],
    structuredContent: { inserted: data.length, logs: data, notes },
  };
}

async function ximiAddTodo(args) {
  if (!ximiSupabase) return noDb();
  const contentRaw = args && args.content;
  if (!contentRaw || !String(contentRaw).trim()) {
    return { isError: true, content: [{ type: 'text', text: 'content 不能为空' }] };
  }
  const dateKey = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : todayBjDateKey();
  const repeatType = ['none', 'daily', 'weekly', 'monthly'].includes(args.repeat_type) ? args.repeat_type : 'none';

  const categories = await fetchTodoCategories();
  let categoryId = null;
  let content = String(contentRaw).trim();
  let note = null;
  if (args.category_name) {
    const matched = matchByName(categories, args.category_name);
    if (matched) {
      categoryId = matched.id;
    } else {
      content = `${content}\n[原分类: ${args.category_name}]`;
      note = `"${args.category_name}" 没匹配到已有事项分类，没有新建分类，已经把原话记进内容里了`;
    }
  }

  const row = {
    content,
    category_id: categoryId,
    important: !!args.important,
    date: dateKey,
    repeat_type: repeatType,
    repeat_weekdays: repeatType === 'weekly' && Array.isArray(args.repeat_weekdays) ? args.repeat_weekdays : null,
    repeat_day_of_month: repeatType === 'monthly' && typeof args.repeat_day_of_month === 'number' ? args.repeat_day_of_month : null,
    reminder_enabled: false,
    reminder_time: null,
    done: false,
    completed_at: null,
    sort_order: 0,
  };

  const { data, error } = await ximiSupabase.from('todo_items').insert(row).select().single();
  if (error) throw error;

  const text = `已经新建事项："${String(contentRaw).trim()}"（${dateKey}${repeatType !== 'none' ? '，' + repeatType : ''}）` + (note ? '\n' + note : '');
  return {
    content: [{ type: 'text', text }],
    structuredContent: { item: data, note },
  };
}

async function ximiCompleteTodo(args) {
  if (!ximiSupabase) return noDb();
  const contentMatch = args && args.content_match && String(args.content_match).trim();
  if (!contentMatch) {
    return { isError: true, content: [{ type: 'text', text: 'content_match 不能为空' }] };
  }
  const dateKey = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : todayBjDateKey();
  const done = args.done !== false; // 不传或true=完成，显式传false=撤销

  const { data: items, error } = await ximiSupabase.from('todo_items').select('*').lte('date', dateKey);
  if (error) throw error;

  const due = (items || []).filter((item) => occursOnDate(item, dateKey));
  const norm = contentMatch.toLowerCase();
  const matches = due.filter((item) => item.content.toLowerCase().includes(norm));

  if (matches.length === 0) {
    const list = due.map((i) => i.content).join('、') || '（这天没有任何事项）';
    return {
      content: [{ type: 'text', text: `没找到内容包含"${contentMatch}"的事项，没有操作。${dateKey} 该出现的事项有：${list}` }],
      structuredContent: { matched: 0, candidates: due.map((i) => ({ id: i.id, content: i.content })) },
    };
  }
  if (matches.length > 1) {
    const list = matches.map((i) => i.content).join('、');
    return {
      content: [{ type: 'text', text: `"${contentMatch}" 匹配到多条事项，不确定是哪一条，没有操作：${list}` }],
      structuredContent: { matched: matches.length, candidates: matches.map((i) => ({ id: i.id, content: i.content })) },
    };
  }

  const item = matches[0];
  if (item.repeat_type === 'none') {
    const { error: updErr } = await ximiSupabase
      .from('todo_items')
      .update({ done, completed_at: done ? new Date().toISOString() : null })
      .eq('id', item.id);
    if (updErr) throw updErr;
  } else if (done) {
    const { error: upsertErr } = await ximiSupabase
      .from('todo_completions')
      .upsert({ todo_id: item.id, date: dateKey }, { onConflict: 'todo_id,date' });
    if (upsertErr) throw upsertErr;
  } else {
    const { error: delErr } = await ximiSupabase.from('todo_completions').delete().eq('todo_id', item.id).eq('date', dateKey);
    if (delErr) throw delErr;
  }

  const text = `已经把"${item.content}"标记${done ? '完成' : '撤销完成'}（${dateKey}）。`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { id: item.id, content: item.content, done },
  };
}

// ============ 工具定义 ============
const TOOLS = [
  {
    name: 'get_recent_touches',
    description: '获取最近 N 分钟内的触摸记录。返回每次触摸的时间、被触摸的部位（"脸"或"大大灵"）、力度值（0-4095）、力度百分比、力度描述（轻轻碰/摸摸/用力按/抱紧/狠狠抱紧）和持续时长（秒）。不传 minutes 时默认查最近 24 小时。',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: '查询最近多少分钟内的记录，默认 1440 分钟（24小时）',
          default: 1440,
        },
      },
    },
  },
  {
    name: 'get_last_touch',
    description: '获取最近一次触摸的详细数据，包括时间、传感器名称、最大力度值、力度百分比、力度描述和持续时长。如果没有触摸记录则返回无数据提示。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ximi_get_today',
    description: '获取西米今天的时间日志（time_logs）和今天该出现但还没完成的事项（todo_items）。按北京时间计算"今天"的范围。需要密钥，见access_key参数说明。',
    inputSchema: {
      type: 'object',
      properties: {
        access_key: { type: 'string', description: '访问密钥。连接器URL本身已经带了密钥（?key=xxx）的话可以不传这个参数。' },
      },
    },
  },
  {
    name: 'ximi_get_daily_logs',
    description: '获取指定某一天（北京时间）的所有时间日志（time_logs），以及那一天该出现的事项（todo_items，含已完成和未完成）。需要密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期，格式 YYYY-MM-DD，北京时间' },
        access_key: { type: 'string', description: '访问密钥。连接器URL本身已经带了密钥的话可以不传。' },
      },
      required: ['date'],
    },
  },
  {
    name: 'ximi_get_weekly_summary',
    description: '最近7天（含今天）各分类花费时间的占比和总时长，纯数字聚合，不生成AI文字总结。需要密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        access_key: { type: 'string', description: '访问密钥。连接器URL本身已经带了密钥的话可以不传。' },
      },
    },
  },
  {
    name: 'ximi_log_time',
    description: '把西米说的一段或几段时间安排直接写进time_logs时间日志表，不用她二次确认。分类按名字匹配现有分类，匹配不上不会新建分类，会把原话记在描述里提醒她自己看；情绪标签同理，匹配不上就不打标签。需要密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          description: '要写入的一条或多条时间记录',
          items: {
            type: 'object',
            properties: {
              category_name: { type: 'string', description: '分类名字，按已有分类名字匹配，不传就不设分类' },
              start_time: { type: 'string', description: '开始时间，ISO 8601格式，比如 2026-09-30T14:00:00+08:00' },
              end_time: { type: 'string', description: '结束时间，ISO 8601格式' },
              description: { type: 'string', description: '这段时间干了什么，可选' },
              tag_names: { type: 'array', items: { type: 'string' }, description: '情绪标签名字数组，按已有标签名字匹配，可选' },
            },
            required: ['start_time', 'end_time'],
          },
        },
        access_key: { type: 'string', description: '访问密钥。连接器URL本身已经带了密钥的话可以不传。' },
      },
      required: ['entries'],
    },
  },
  {
    name: 'ximi_add_todo',
    description: '新增一条事项待办。分类按名字匹配现有事项分类，匹配不上不会新建分类，会把原话记进内容里提醒她自己看。需要密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '事项内容' },
        date: { type: 'string', description: '起算日期，格式 YYYY-MM-DD，北京时间，不传默认今天' },
        category_name: { type: 'string', description: '分类名字，按已有分类匹配，不传就不设分类' },
        important: { type: 'boolean', description: '是否星标重要，默认false' },
        repeat_type: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: '重复规则，默认none（不重复）' },
        repeat_weekdays: { type: 'array', items: { type: 'number' }, description: 'repeat_type=weekly时用，0=周日...6=周六' },
        repeat_day_of_month: { type: 'number', description: 'repeat_type=monthly时用，1-31；0表示"最后一天"' },
        access_key: { type: 'string', description: '访问密钥。连接器URL本身已经带了密钥的话可以不传。' },
      },
      required: ['content'],
    },
  },
  {
    name: 'ximi_complete_todo',
    description: '把一条事项标记完成或撤销完成。按内容模糊匹配当天该出现的事项，找不到明确唯一对应的会如实说没找到或有歧义，不会乱勾一条。需要密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        content_match: { type: 'string', description: '事项内容的关键词，用来模糊匹配' },
        date: { type: 'string', description: '哪一天的，格式 YYYY-MM-DD，北京时间，不传默认今天' },
        done: { type: 'boolean', description: 'true=标记完成，false=撤销完成，默认true' },
        access_key: { type: 'string', description: '访问密钥。连接器URL本身已经带了密钥的话可以不传。' },
      },
      required: ['content_match'],
    },
  },
];

// ============ 工具执行 ============
// 改成 async：ximi_* 那几个新工具要查数据库，原有两个触摸工具的分支不受
// 影响（同步 return 在 async 函数里照样正常工作，会被自动包成 resolved
// promise）。
async function executeTool(toolName, args, context) {
  const { history, latestTouchSummary, touchState } = context;

  switch (toolName) {
    case 'get_recent_touches': {
      const minutes = (args && typeof args.minutes === 'number') ? args.minutes : 1440;
      const cutoff = Date.now() - minutes * 60 * 1000;

      const results = history.filter(e => {
        const t = new Date(e.time).getTime();
        return !isNaN(t) && t >= cutoff;
      }).map(e => {
        const d = new Date(e.time);
        const pad = n => n < 10 ? '0' + n : '' + n;
        const timeStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        return {
          time: timeStr,
          bodyPart: e.sensorLabel,
          force: e.maxForce,
          forcePercent: Math.round((e.maxForce / 4095) * 100),
          description: e.description,
          durationSeconds: e.duration,
        };
      });

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `最近 ${minutes >= 60 ? Math.round(minutes/60) + ' 小时' : minutes + ' 分钟'}内没有触摸记录。`,
          }],
        };
      }

      const timeLabel = minutes >= 1440 ? '24小时' : minutes >= 60 ? Math.round(minutes/60) + '小时' : minutes + '分钟';
      const summary = `最近${timeLabel}内共 ${results.length} 次触摸：\n\n` +
        results.map((r, i) =>
          `${i + 1}. 时间: ${r.time} | 部位: ${r.bodyPart} | 力度: ${r.forcePercent}%(${r.description}) | 持续: ${r.durationSeconds}秒`
        ).join('\n');

      return {
        content: [{
          type: 'text',
          text: summary,
        }],
        structuredContent: {
          count: results.length,
          minutes: minutes,
          touches: results,
        },
      };
    }

    case 'get_last_touch': {
      // 优先返回 latestTouchSummary（最近完成的触摸）
      let data = latestTouchSummary;

      // 如果没有完成的触摸，检查是否有正在进行的触摸
      if (!data) {
        const live = [];
        if (touchState.s1.touching) {
          live.push({
            sensor: '脸',
            currentForce: touchState.s1.maxForce,
            forcePercent: Math.round((touchState.s1.maxForce / 4095) * 100),
            durationSeconds: Math.round((Date.now() - touchState.s1.startTime) / 100) / 10,
            status: '正在进行中',
          });
        }
        if (touchState.s2.touching) {
          live.push({
            sensor: '大大灵',
            currentForce: touchState.s2.maxForce,
            forcePercent: Math.round((touchState.s2.maxForce / 4095) * 100),
            durationSeconds: Math.round((Date.now() - touchState.s2.startTime) / 100) / 10,
            status: '正在进行中',
          });
        }

        if (live.length > 0) {
          const text = `当前有 ${live.length} 个传感器正在被触摸：\n` +
            live.map(l =>
              `[${l.sensor}] 力度: ${l.currentForce}/4095 (${l.forcePercent}%) - ${l.durationSeconds}秒 (进行中)`
            ).join('\n');
          return {
            content: [{ type: 'text', text }],
            structuredContent: { touches: live, status: 'live' },
          };
        }

        return {
          content: [{
            type: 'text',
            text: '目前没有任何触摸记录。设备可能刚刚启动或尚未被触摸。',
          }],
        };
      }

      const d = new Date(data.lastTouch);
      const pad = n => n < 10 ? '0' + n : '' + n;
      const timeStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      const text = `最近一次触摸：\n` +
        `  时间: ${timeStr}\n` +
        `  部位: ${data.sensorLabel}\n` +
        `  力度: ${data.forcePercent}% (${data.description})\n` +
        `  原始值: ${data.maxForce}/4095\n` +
        `  持续时长: ${data.duration}秒`;

      return {
        content: [{ type: 'text', text }],
        structuredContent: data,
      };
    }

    case 'ximi_get_today': {
      if (!checkXimiAccess(args, context)) return accessDenied();
      try {
        return await ximiGetToday();
      } catch (e) {
        return dbError(e);
      }
    }

    case 'ximi_get_daily_logs': {
      if (!checkXimiAccess(args, context)) return accessDenied();
      try {
        return await ximiGetDailyLogs(args);
      } catch (e) {
        return dbError(e);
      }
    }

    case 'ximi_get_weekly_summary': {
      if (!checkXimiAccess(args, context)) return accessDenied();
      try {
        return await ximiGetWeeklySummary();
      } catch (e) {
        return dbError(e);
      }
    }

    case 'ximi_log_time': {
      if (!checkXimiAccess(args, context)) return accessDenied();
      try {
        return await ximiLogTime(args);
      } catch (e) {
        return dbError(e);
      }
    }

    case 'ximi_add_todo': {
      if (!checkXimiAccess(args, context)) return accessDenied();
      try {
        return await ximiAddTodo(args);
      } catch (e) {
        return dbError(e);
      }
    }

    case 'ximi_complete_todo': {
      if (!checkXimiAccess(args, context)) return accessDenied();
      try {
        return await ximiCompleteTodo(args);
      } catch (e) {
        return dbError(e);
      }
    }

    default:
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `未知工具: ${toolName}`,
        }],
      };
  }
}

// ============ JSON-RPC 处理 ============
async function handleJsonRpc(body, context) {
  const { id, method, params } = body;

  // JSON-RPC 通知（无 id）—— 返回 202
  if (id === undefined || id === null) {
    return { status: 202, body: null };
  }

  switch (method) {
    case 'initialize': {
      const clientVersion = params && params.protocolVersion;
      // 协商协议版本
      const negotiatedVersion = PROTOCOL_VERSION;

      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id,
          result: {
            protocolVersion: negotiatedVersion,
            serverInfo: {
              name: 'touch-doll-mcp',
              version: '1.0.0',
            },
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
            },
            // 告诉客户端服务器支持的指令
            instructions: '这是一个共感娃娃触摸数据 MCP 服务器。可查询最近的触摸记录和最后一次触摸详情。传感器1标注为"脸"，传感器2标注为"大大灵"。',
          },
        },
      };
    }

    case 'notifications/initialized': {
      // 客户端发来的初始化完成通知，返回 202
      return { status: 202, body: null };
    }

    case 'tools/list': {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id,
          result: {
            tools: TOOLS,
          },
        },
      };
    }

    case 'tools/call': {
      const toolName = params && params.name;
      const args = (params && params.arguments) || {};

      const result = await executeTool(toolName, args, context);

      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id,
          result: result,
        },
      };
    }

    case 'resources/list': {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id,
          result: { resources: [] },
        },
      };
    }

    case 'prompts/list': {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id,
          result: { prompts: [] },
        },
      };
    }

    case 'ping': {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id,
          result: {},
        },
      };
    }

    default: {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        },
      };
    }
  }
}

// ============ HTTP 请求处理入口 ============
function handleMcpRequest(req, res, context) {
  // 收集请求体
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    // 空 body（可能是 GET 或 HEAD 请求探测）
    if (!body || body.trim() === '') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request: empty body' },
      }));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      }));
      return;
    }

    let result;
    try {
      result = await handleJsonRpc(parsed, context);
    } catch (e) {
      // ximi_*工具里各自的try/catch已经兜住了数据库层面的报错；这里是最后
      // 一道防线，防止任何没预料到的异常变成未处理的promise rejection
      console.error('[mcp] handleJsonRpc 抛出未捕获异常:', e);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed && parsed.id,
        error: { code: -32603, message: 'Internal error' },
      }));
      return;
    }

    if (result.body === null) {
      // 通知类，返回 202 无 body
      res.writeHead(202);
      res.end();
      return;
    }

    res.writeHead(result.status, {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    });
    res.end(JSON.stringify(result.body));
  });
}

module.exports = { handleMcpRequest, PROTOCOL_VERSION, TOOLS, executeTool };
