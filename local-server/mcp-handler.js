/*
 * MCP Handler — Model Context Protocol (Streamable HTTP)
 *
 * 实现 JSON-RPC 2.0 over HTTP，支持以下方法：
 *   - initialize:        握手，返回服务器信息和能力
 *   - tools/list:        返回可用工具列表
 *   - tools/call:        执行工具，返回结果
 *
 * 工具：
 *   - get_recent_touches: 获取最近N分钟的触摸记录
 *   - get_last_touch:    获取最近一次触摸详情
 *
 * 协议版本：2025-06-18（兼容 Claude 自定义连接器）
 */

// 支持的协议版本
const PROTOCOL_VERSION = '2025-06-18';

// ============ 工具定义 ============
const TOOLS = [
  {
    name: 'get_recent_touches',
    description: '获取最近 N 分钟内的触摸记录。返回每次触摸的时间戳、传感器名称（脸/大大灵）、力度值、力度百分比、力度描述和持续时长。',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: '查询最近多少分钟内的记录，默认 5 分钟',
          default: 5,
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
];

// ============ 工具执行 ============
function executeTool(toolName, args, context) {
  const { history, latestTouchSummary, touchState } = context;

  switch (toolName) {
    case 'get_recent_touches': {
      const minutes = (args && typeof args.minutes === 'number') ? args.minutes : 5;
      const cutoff = Date.now() - minutes * 60 * 1000;

      const results = history.filter(e => {
        const t = new Date(e.time).getTime();
        return !isNaN(t) && t >= cutoff;
      }).map(e => ({
        time: e.time,
        sensor: e.sensorLabel,
        force: e.maxForce,
        forcePercent: Math.round((e.maxForce / 4095) * 100),
        description: e.description,
        durationSeconds: e.duration,
      }));

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `最近 ${minutes} 分钟内没有触摸记录。`,
          }],
        };
      }

      const summary = `最近 ${minutes} 分钟内共 ${results.length} 次触摸：\n` +
        results.map((r, i) =>
          `${i + 1}. [${r.sensor}] ${r.time}\n` +
          `   力度: ${r.force}/4095 (${r.forcePercent}%) - ${r.description}\n` +
          `   持续: ${r.durationSeconds}秒`
        ).join('\n\n');

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

      const text = `最近一次触摸：\n` +
        `  传感器: ${data.sensorLabel}\n` +
        `  时间: ${data.lastTouch}\n` +
        `  最大力度: ${data.maxForce}/4095 (${data.forcePercent}%)\n` +
        `  力度描述: ${data.description}\n` +
        `  持续时长: ${data.duration}秒`;

      return {
        content: [{ type: 'text', text }],
        structuredContent: data,
      };
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
function handleJsonRpc(body, context) {
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

      const result = executeTool(toolName, args, context);

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
  req.on('end', () => {
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

    const result = handleJsonRpc(parsed, context);

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
