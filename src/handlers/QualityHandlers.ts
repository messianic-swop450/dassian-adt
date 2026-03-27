import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl, buildSourceUrl, NESTED_TYPES } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';

export class QualityHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_syntax_check',
        description:
          'Run a syntax check on an ABAP object. Returns errors and warnings. ' +
          'Use this after writing source to verify correctness before activating. ' +
          'Supports all types including FUGR/FF (function modules).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: 'Object type (e.g. CLAS, PROG/I, FUGR/FF)' },
            fugr: { type: 'string', description: 'Parent function group — required for FUGR/FF if auto-discovery fails' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_atc_run',
        description:
          'Run ABAP Test Cockpit (ATC) checks on an object. ' +
          'Returns findings grouped by severity (error, warning, info). ' +
          'Clean core compliance issues appear here.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: 'Object type' },
            variant: { type: 'string', description: 'ATC check variant to use (default: DEFAULT)' }
          },
          required: ['name', 'type']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_syntax_check': return this.handleSyntaxCheck(args);
      case 'abap_atc_run':      return this.handleAtcRun(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleSyntaxCheck(args: any): Promise<any> {
    if (!args.name || !args.type) {
      this.fail('abap_syntax_check requires name (object name) and type (e.g. CLAS, PROG/I).');
    }
    try {
      let sourceUrl: string;

      if (NESTED_TYPES.has(args.type?.toUpperCase())) {
        const resolved = await this.resolveNestedUrl(args.name, args.type, args.fugr);
        sourceUrl = resolved.sourceUrl;
      } else {
        sourceUrl = buildSourceUrl(args.name, args.type);
      }

      const source = await this.withSession(() =>
        this.adtclient.getObjectSource(sourceUrl)
      );
      const result = await this.withSession(() =>
        this.adtclient.syntaxCheck(sourceUrl, sourceUrl, source as string)
      );
      return this.success({ name: args.name, syntaxResult: result });
    } catch (error: any) {
      this.fail(formatError(`abap_syntax_check(${args.name})`, error));
    }
  }

  private async handleAtcRun(args: any): Promise<any> {
    if (!args.name || !args.type) {
      this.fail('abap_atc_run requires name (object name) and type (e.g. CLAS, PROG/P). ' +
        'To check a transport\'s objects, first list them with transport_contents, then run ATC per object.');
    }
    const objectUrl = buildObjectUrl(args.name, args.type);
    const variant = args.variant || 'DEFAULT';
    try {
      // When ciCheckFlavour=true (common on dev systems), createAtcRun uses a CI-scoped
      // check that ignores the variant and runs fewer checks than a full Eclipse run.
      // Instead: fetch the existing worklist for the variant (populated by the last full run).
      // This returns the same results Eclipse shows, with the correct variant applied.
      const worklistId = await this.withSession(() =>
        this.adtclient.atcCheckVariant(variant)
      ) as string;

      const worklists = await this.withSession(() =>
        this.adtclient.atcWorklists(worklistId)
      );

      return this.success({ name: args.name, variant, findings: worklists });
    } catch (error: any) {
      this.fail(formatError(`abap_atc_run(${args.name})`, error));
    }
  }
}
