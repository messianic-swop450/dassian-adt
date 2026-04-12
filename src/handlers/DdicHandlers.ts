import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';

export class DdicHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'ddic_element',
        annotations: { readOnlyHint: true },
        description:
          'Retrieve DDIC metadata for a CDS view or data element — field names, data types, ' +
          'key flags, data element labels, lengths, decimals, and CDS annotations. ' +
          'Pass the CDS entity path (e.g. /DSN/C_MY_VIEW or SEPM_I_PRODUCT_E). ' +
          'For associations, set getTargetForAssociation=true to resolve the target entity\'s fields. ' +
          'For extension views, set getExtensionViews=true.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'CDS entity or data element path, e.g. /DSN/C_MY_VIEW or SEPM_I_PRODUCT_E. ' +
                           'For multiple paths pass a comma-separated string.'
            },
            getTargetForAssociation: {
              type: 'boolean',
              description: 'Resolve association targets (default: false)'
            },
            getExtensionViews: {
              type: 'boolean',
              description: 'Include extension views (default: false)'
            },
            getSecondaryObjects: {
              type: 'boolean',
              description: 'Include secondary objects (default: false)'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'ddic_references',
        annotations: { readOnlyHint: true },
        description:
          'List all DDIC objects that reference a given CDS entity or data element. ' +
          'Returns each referencing object\'s URI, type, name, and path. ' +
          'Useful for understanding the impact of changing a data model.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'CDS entity or DDIC path to find references for. ' +
                           'For multiple paths pass a comma-separated string.'
            }
          },
          required: ['path']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'ddic_element':    return this.handleDdicElement(args);
      case 'ddic_references': return this.handleDdicReferences(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private parsePath(raw: string): string | string[] {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
  }

  private async handleDdicElement(args: any): Promise<any> {
    const path = this.parsePath(args.path);
    try {
      const element = await this.withSession(() =>
        this.adtclient.ddicElement(
          path,
          args.getTargetForAssociation ?? false,
          args.getExtensionViews       ?? false,
          args.getSecondaryObjects     ?? false
        )
      );
      return this.success(element);
    } catch (error: any) {
      this.fail(formatError(`ddic_element(${args.path})`, error));
    }
  }

  private async handleDdicReferences(args: any): Promise<any> {
    const path = this.parsePath(args.path);
    try {
      const refs = await this.withSession(() =>
        this.adtclient.ddicRepositoryAccess(path)
      );
      return this.success({ path: args.path, count: (refs as any[]).length, references: refs });
    } catch (error: any) {
      this.fail(formatError(`ddic_references(${args.path})`, error));
    }
  }
}
