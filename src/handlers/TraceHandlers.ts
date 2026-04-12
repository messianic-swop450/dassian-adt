import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';
import type { TraceParameters, TracesCreationConfig } from 'abap-adt-api';

export class TraceHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'traces_list',
        annotations: { readOnlyHint: true },
        description:
          'List ABAP runtime trace runs stored on the system. ' +
          'Returns each trace run with ID, title, author, timing breakdown (ABAP / system / DB), ' +
          'object name, and state. Use the ID with traces_hit_list, traces_statements, or traces_db_access ' +
          'to drill into a specific run.',
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'Filter by user. Omit to use the session user.' }
          }
        }
      },
      {
        name: 'traces_set_parameters',
        description:
          'Configure trace collection parameters and return a parametersId. ' +
          'The parametersId is required by traces_create_config. ' +
          'Sensible defaults are applied — only override if you need specific trace granularity.',
        inputSchema: {
          type: 'object',
          properties: {
            description:             { type: 'string',  description: 'Human-readable label for this parameter set' },
            sqlTrace:                { type: 'boolean', description: 'Trace SQL statements (default: true)' },
            allProceduralUnits:      { type: 'boolean', description: 'Trace all function modules, methods, subroutines (default: true)' },
            allMiscAbapStatements:   { type: 'boolean', description: 'Trace misc ABAP statements (default: false)' },
            allInternalTableEvents:  { type: 'boolean', description: 'Trace internal table operations (default: false)' },
            allDynproEvents:         { type: 'boolean', description: 'Trace dynpro events (default: false)' },
            aggregate:               { type: 'boolean', description: 'Aggregate identical calls (default: true)' },
            withRfcTracing:          { type: 'boolean', description: 'Include RFC tracing (default: false)' },
            allSystemKernelEvents:   { type: 'boolean', description: 'Trace system kernel events (default: false)' },
            allDbEvents:             { type: 'boolean', description: 'Trace all DB events (default: false)' },
            explicitOnOff:           { type: 'boolean', description: 'Require explicit on/off toggle (default: false)' },
            maxSizeForTraceFile:     { type: 'number',  description: 'Max trace file size in bytes (default: 10000000)' },
            maxTimeForTracing:       { type: 'number',  description: 'Max trace duration in seconds (default: 300)' }
          },
          required: ['description']
        }
      },
      {
        name: 'traces_create_config',
        description:
          'Create a trace configuration that captures the next execution of a user\'s request. ' +
          'First call traces_set_parameters to get a parametersId. ' +
          'The trace activates when the target user next runs the specified transaction, URL, report, or FM. ' +
          'Returns the configuration ID.',
        inputSchema: {
          type: 'object',
          properties: {
            parametersId:      { type: 'string', description: 'ID from traces_set_parameters' },
            description:       { type: 'string', description: 'Label for this trace configuration' },
            traceUser:         { type: 'string', description: 'SAP user whose next execution to trace' },
            traceClient:       { type: 'string', description: 'SAP client (e.g. 100). Defaults to current session client.' },
            processType:       { type: 'string', description: 'Process type to trace (default: ANY)', enum: ['HTTP', 'DIALOG', 'RFC', 'BATCH', 'SHARED_OBJECTS_AREA', 'ANY'] },
            objectType:        { type: 'string', description: 'Object type to trace (default: ANY)', enum: ['FUNCTION_MODULE', 'URL', 'TRANSACTION', 'REPORT', 'SHARED_OBJECTS_AREA', 'ANY'] },
            expires:           { type: 'string', description: 'Expiry datetime (ISO 8601). Default: 24 hours from now.' },
            maximalExecutions: { type: 'number', description: 'Stop after this many captures (default: 1)' }
          },
          required: ['parametersId', 'description', 'traceUser']
        }
      },
      {
        name: 'traces_hit_list',
        annotations: { readOnlyHint: true },
        description:
          'Get the hit list (call frequency / gross time breakdown) for a trace run. ' +
          'Shows the most expensive program units ranked by gross time and hit count. ' +
          'Use the trace ID from traces_list.',
        inputSchema: {
          type: 'object',
          properties: {
            id:               { type: 'string',  description: 'Trace run ID from traces_list' },
            withSystemEvents: { type: 'boolean', description: 'Include system-level events (default: false)' }
          },
          required: ['id']
        }
      },
      {
        name: 'traces_statements',
        annotations: { readOnlyHint: true },
        description:
          'Get individual ABAP statement execution details for a trace run. ' +
          'Returns statement-level timing with calling program context. ' +
          'Use the trace ID from traces_list.',
        inputSchema: {
          type: 'object',
          properties: {
            id:               { type: 'string',  description: 'Trace run ID from traces_list' },
            withSystemEvents: { type: 'boolean', description: 'Include system events (default: false)' },
            pageSize:         { type: 'number',  description: 'Max statements to return (default: 100)' },
            pageNumber:       { type: 'number',  description: 'Page number for pagination (default: 1)' }
          },
          required: ['id']
        }
      },
      {
        name: 'traces_db_access',
        annotations: { readOnlyHint: true },
        description:
          'Get database access statistics for a trace run. ' +
          'Shows tables accessed, statement types (SELECT/INSERT/UPDATE), access counts, and timing. ' +
          'Use to identify N+1 query patterns and expensive DB operations.',
        inputSchema: {
          type: 'object',
          properties: {
            id:               { type: 'string',  description: 'Trace run ID from traces_list' },
            withSystemEvents: { type: 'boolean', description: 'Include system DB events (default: false)' }
          },
          required: ['id']
        }
      },
      {
        name: 'traces_delete',
        annotations: { destructiveHint: true },
        description: 'Delete a trace run result. The trace configuration is not affected.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Trace run ID from traces_list' }
          },
          required: ['id']
        }
      },
      {
        name: 'traces_delete_config',
        annotations: { destructiveHint: true },
        description: 'Delete a trace configuration (stops future captures).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Trace configuration ID from traces_create_config' }
          },
          required: ['id']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'traces_list':          return this.handleList(args);
      case 'traces_set_parameters': return this.handleSetParameters(args);
      case 'traces_create_config': return this.handleCreateConfig(args);
      case 'traces_hit_list':      return this.handleHitList(args);
      case 'traces_statements':    return this.handleStatements(args);
      case 'traces_db_access':     return this.handleDbAccess(args);
      case 'traces_delete':        return this.handleDelete(args);
      case 'traces_delete_config': return this.handleDeleteConfig(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleList(args: any): Promise<any> {
    try {
      const user = args.user || (this.adtclient as any).username || (this.adtclient as any).h?.username || '';
      const result = await this.withSession(() => this.adtclient.tracesList(user));
      const runs = (result as any).runs || [];
      return this.success({
        count: runs.length,
        runs: runs.map((r: any) => ({
          id: r.id,
          title: r.title,
          author: r.author,
          published: r.published,
          updated: r.updated,
          objectName: r.extendedData?.objectName,
          state: r.extendedData?.state,
          runtimeMs: r.extendedData?.runtime,
          runtimeAbapMs: r.extendedData?.runtimeABAP,
          runtimeDbMs: r.extendedData?.runtimeDatabase,
          sizeBytes: r.extendedData?.size
        }))
      });
    } catch (error: any) {
      this.fail(formatError('traces_list', error));
    }
  }

  private async handleSetParameters(args: any): Promise<any> {
    const params: TraceParameters = {
      description:            args.description,
      sqlTrace:               args.sqlTrace               ?? true,
      allProceduralUnits:     args.allProceduralUnits     ?? true,
      allMiscAbapStatements:  args.allMiscAbapStatements  ?? false,
      allInternalTableEvents: args.allInternalTableEvents ?? false,
      allDynproEvents:        args.allDynproEvents        ?? false,
      aggregate:              args.aggregate              ?? true,
      withRfcTracing:         args.withRfcTracing         ?? false,
      allSystemKernelEvents:  args.allSystemKernelEvents  ?? false,
      allDbEvents:            args.allDbEvents            ?? false,
      explicitOnOff:          args.explicitOnOff          ?? false,
      maxSizeForTraceFile:    args.maxSizeForTraceFile     ?? 10_000_000,
      maxTimeForTracing:      args.maxTimeForTracing       ?? 300,
    };
    try {
      const parametersId = await this.withSession(() =>
        this.adtclient.tracesSetParameters(params)
      ) as string;
      return this.success({ parametersId, description: args.description });
    } catch (error: any) {
      this.fail(formatError('traces_set_parameters', error));
    }
  }

  private async handleCreateConfig(args: any): Promise<any> {
    const client = args.traceClient
      || (this.adtclient as any).client
      || (this.adtclient as any).h?.client
      || '100';
    const expires = args.expires ? new Date(args.expires) : new Date(Date.now() + 24 * 60 * 60 * 1000);

    const config: TracesCreationConfig = {
      parametersId:      args.parametersId,
      description:       args.description,
      traceUser:         args.traceUser,
      traceClient:       String(client),
      processType:       (args.processType  || 'ANY') as any,
      objectType:        (args.objectType   || 'ANY') as any,
      expires,
      maximalExecutions: args.maximalExecutions ?? 1,
    };

    try {
      const result = await this.withSession(() =>
        this.adtclient.tracesCreateConfiguration(config)
      );
      return this.success({ description: args.description, traceUser: args.traceUser, result });
    } catch (error: any) {
      this.fail(formatError('traces_create_config', error));
    }
  }

  private async handleHitList(args: any): Promise<any> {
    try {
      const result = await this.withSession(() =>
        this.adtclient.tracesHitList(args.id, args.withSystemEvents ?? false)
      );
      return this.success(result);
    } catch (error: any) {
      this.fail(formatError(`traces_hit_list(${args.id})`, error));
    }
  }

  private async handleStatements(args: any): Promise<any> {
    const options: any = {};
    if (args.withSystemEvents !== undefined) options.withSystemEvents = args.withSystemEvents;
    if (args.pageSize !== undefined)         options.pageSize         = args.pageSize;
    if (args.pageNumber !== undefined)       options.pageNumber       = args.pageNumber;
    try {
      const result = await this.withSession(() =>
        this.adtclient.tracesStatements(args.id, options)
      );
      return this.success(result);
    } catch (error: any) {
      this.fail(formatError(`traces_statements(${args.id})`, error));
    }
  }

  private async handleDbAccess(args: any): Promise<any> {
    try {
      const result = await this.withSession(() =>
        this.adtclient.tracesDbAccess(args.id, args.withSystemEvents ?? false)
      );
      return this.success(result);
    } catch (error: any) {
      this.fail(formatError(`traces_db_access(${args.id})`, error));
    }
  }

  private async handleDelete(args: any): Promise<any> {
    try {
      // tracesDelete is exposed via the underlying h client
      const tracesApi = require('abap-adt-api/build/api/traces.js');
      const h = (this.adtclient as any).h;
      await this.withSession(() => tracesApi.tracesDelete(h, args.id));
      return this.success({ id: args.id, deleted: true });
    } catch (error: any) {
      this.fail(formatError(`traces_delete(${args.id})`, error));
    }
  }

  private async handleDeleteConfig(args: any): Promise<any> {
    try {
      const tracesApi = require('abap-adt-api/build/api/traces.js');
      const h = (this.adtclient as any).h;
      await this.withSession(() => tracesApi.tracesDeleteConfiguration(h, args.id));
      return this.success({ id: args.id, deleted: true });
    } catch (error: any) {
      this.fail(formatError(`traces_delete_config(${args.id})`, error));
    }
  }
}
