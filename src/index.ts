#!/usr/bin/env node

import { config } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { ADTClient, session_types } from 'abap-adt-api';
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
      { name: 'mcp-abap-abap-adt-api', version: '2.0.0' },
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

  async run() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    // Log client capabilities so we can see if elicitation is supported
    const clientCaps = this.getClientCapabilities();
    console.error('ABAP ADT MCP server v2.0 running on stdio');
    console.error('Client capabilities:', JSON.stringify(clientCaps, null, 2));

    process.on('SIGINT',  async () => { await this.close(); process.exit(0); });
    process.on('SIGTERM', async () => { await this.close(); process.exit(0); });
  }
}

const server = new AbapAdtServer();
server.run().catch(console.error);
