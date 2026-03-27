#!/usr/bin/env node

import { config } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { ADTClient, session_types } from 'abap-adt-api';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';

import { SourceHandlers }    from './handlers/SourceHandlers.js';
import { ObjectHandlers }    from './handlers/ObjectHandlers.js';
import { RunHandlers }       from './handlers/RunHandlers.js';
import { TransportHandlers } from './handlers/TransportHandlers.js';
import { DataHandlers }      from './handlers/DataHandlers.js';
import { QualityHandlers }   from './handlers/QualityHandlers.js';
import { GitHandlers }       from './handlers/GitHandlers.js';
import { SystemHandlers }    from './handlers/SystemHandlers.js';

config({ path: path.resolve(__dirname, '../.env') });

export class AbapAdtServer extends Server {
  private adtClient: ADTClient;
  private sourceHandlers:    SourceHandlers;
  private objectHandlers:    ObjectHandlers;
  private runHandlers:       RunHandlers;
  private transportHandlers: TransportHandlers;
  private dataHandlers:      DataHandlers;
  private qualityHandlers:   QualityHandlers;
  private gitHandlers:       GitHandlers;
  private systemHandlers:    SystemHandlers;

  constructor() {
    super(
      { name: 'dassian-adt', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );

    const missingVars = ['SAP_URL', 'SAP_USER', 'SAP_PASSWORD'].filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    this.adtClient = new ADTClient(
      process.env.SAP_URL as string,
      process.env.SAP_USER as string,
      process.env.SAP_PASSWORD as string,
      process.env.SAP_CLIENT as string,
      process.env.SAP_LANGUAGE as string
    );
    this.adtClient.stateful = session_types.stateful;

    this.sourceHandlers    = new SourceHandlers(this.adtClient);
    this.objectHandlers    = new ObjectHandlers(this.adtClient);
    this.runHandlers       = new RunHandlers(this.adtClient);
    this.transportHandlers = new TransportHandlers(this.adtClient);
    this.dataHandlers      = new DataHandlers(this.adtClient);
    this.qualityHandlers   = new QualityHandlers(this.adtClient);
    this.gitHandlers       = new GitHandlers(this.adtClient);
    this.systemHandlers    = new SystemHandlers(this.adtClient);

    // Inject elicitation capability into handlers that need user confirmation.
    // Falls back gracefully if the connected client doesn't support elicitation.
    const elicitFn = (params: any) => this.elicitInput(params);
    for (const handler of this.allHandlers()) {
      handler.setElicit(elicitFn);
    }

    this.setupHandlers();
  }

  private allHandlers() {
    return [
      this.sourceHandlers,
      this.objectHandlers,
      this.runHandlers,
      this.transportHandlers,
      this.dataHandlers,
      this.qualityHandlers,
      this.gitHandlers,
      this.systemHandlers,
    ];
  }

  private setupHandlers() {
    this.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.allHandlers().flatMap(h => h.getTools())
    }));

    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      for (const handler of this.allHandlers()) {
        const tools = handler.getTools().map(t => t.name);
        if (tools.includes(name)) {
          try {
            const result = await handler.validateAndHandle(name, args || {});
            // Handlers return already-formatted content — pass through
            if (result?.content) return result;
            // Fallback serialization for anything that slips through
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
              }]
            };
          } catch (error: any) {
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, error.message || 'Unknown error');
          }
        }
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    });
  }

  /**
   * Run in stdio mode (default). Each Claude Code instance spawns its own server process.
   * Use this for local development or single-user setups.
   */
  async runStdio() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    const clientCaps = this.getClientCapabilities();
    console.error('dassian-adt v2.0 running on stdio');
    console.error('Client capabilities:', JSON.stringify(clientCaps, null, 2));

    process.on('SIGINT',  async () => { await this.close(); process.exit(0); });
    process.on('SIGTERM', async () => { await this.close(); process.exit(0); });
  }

  /**
   * Run in HTTP mode. A single server process handles multiple clients via Streamable HTTP.
   * Use this for team-wide deployment — register the URL as a remote MCP integration.
   *
   * Set MCP_HTTP_PORT (default 3000) and optionally MCP_HTTP_PATH (default /mcp).
   */
  async runHttp() {
    const port = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
    const mcpPath = process.env.MCP_HTTP_PATH || '/mcp';

    // Per-session transport map — each MCP client gets its own session
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: AbapAdtServer }>();

    const httpServer = createServer(async (req, res) => {
      // CORS headers for browser-based clients
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check endpoint
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
        return;
      }

      // Only handle the MCP path
      if (req.url !== mcpPath && !req.url?.startsWith(mcpPath + '?')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — route to its transport
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      if (sessionId && !sessions.has(sessionId)) {
        // Invalid session ID
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      // New session — create transport and server instance
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // Each session gets its own AbapAdtServer with its own SAP connection
      const sessionServer = new AbapAdtServer();
      await sessionServer.connect(transport);

      // Store session after connection (sessionId is set during the init handshake)
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          console.error(`[HTTP] Session closed: ${transport.sessionId} (${sessions.size} active)`);
        }
      };

      // Handle the initial request (triggers the init handshake which sets sessionId)
      await transport.handleRequest(req, res);

      // Store session AFTER the request is handled (sessionId is now set)
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server: sessionServer });
        console.error(`[HTTP] New session: ${transport.sessionId} (${sessions.size} active)`);
      }
    });

    httpServer.listen(port, () => {
      console.error(`dassian-adt v2.0 running on http://0.0.0.0:${port}${mcpPath}`);
      console.error(`Health check: http://0.0.0.0:${port}/health`);
      console.error(`SAP system: ${process.env.SAP_URL}`);
    });

    process.on('SIGINT',  () => { httpServer.close(); process.exit(0); });
    process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });
  }
}

// Determine transport mode from environment
const server = new AbapAdtServer();
const mode = process.env.MCP_TRANSPORT || 'stdio';

if (mode === 'http') {
  server.runHttp().catch(console.error);
} else {
  server.runStdio().catch(console.error);
}
