import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl, buildSourceUrl, getSupportedTypes, NESTED_TYPES } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';

const SUPPORTED = getSupportedTypes().join(', ');

export class SourceHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_get_source',
        description:
          'Get the ABAP source code for any object by name and type. ' +
          'No URL construction needed — just provide the object name and type. ' +
          `Supported types: ${SUPPORTED}. ` +
          'For namespaced objects pass the raw name including slashes, e.g. /DSN/MY_CLASS.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Object name, e.g. ZCL_MY_CLASS or /DSN/MY_CLASS'
            },
            type: {
              type: 'string',
              description: `Object type. FUGR/F = function group CONTAINER (no source — use abap_get_function_group to get all its source). FUGR/I = specific function group include (auto-discovers parent). FUGR/FF = specific function module source — provide fugr param if known. Other common: CLAS, PROG/I, PROG/P, DDLS/DF, ENHO/XHH. Full list: ${SUPPORTED}`
            },
            fugr: {
              type: 'string',
              description: 'Parent function group name. Required for FUGR/FF if auto-discovery fails. E.g. if FM is /DSN/010BWE_SC, fugr is /DSN/010BWE.'
            }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_set_source',
        description:
          'Write ABAP source code for an object. Handles lock → write → unlock automatically. ' +
          'For objects outside $TMP, provide a transport number. ' +
          'IMPORTANT: After writing source, call abap_activate to make it active.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Object name, e.g. ZCL_MY_CLASS or /DSN/MY_CLASS'
            },
            type: {
              type: 'string',
              description: `Object type. Common: CLAS, PROG/I, DDLS/DF, ENHO/XHH, FUGR/FF (function module). Full list: ${SUPPORTED}`
            },
            source: {
              type: 'string',
              description: 'Full ABAP source code to write'
            },
            transport: {
              type: 'string',
              description: 'Transport request number (e.g. D23K900123). Required for objects outside $TMP. Omit for $TMP objects.'
            },
            fugr: {
              type: 'string',
              description: 'Parent function group name. Required for FUGR/FF if auto-discovery fails. E.g. if FM is /DSN/010BWE_SC, fugr is /DSN/010BWE.'
            }
          },
          required: ['name', 'type', 'source']
        }
      },
      {
        name: 'abap_get_function_group',
        description:
          'Get all source for a function group in one call: top include, all user includes (U01..UXX), ' +
          'and all function module sources. Returns a map of include/FM name → source. ' +
          'Use this instead of multiple abap_get_source calls when you need to understand or search a whole function group.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Function group name, e.g. /DSN/010BWE or ZBILLING'
            }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_get_source':           return this.handleGetSource(args);
      case 'abap_set_source':           return this.handleSetSource(args);
      case 'abap_get_function_group':   return this.handleGetFunctionGroup(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleGetSource(args: any): Promise<any> {
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
      return this.success({ source, name: args.name, type: args.type });
    } catch (error: any) {
      this.fail(formatError(`abap_get_source(${args.name})`, error));
    }
  }

  private async handleSetSource(args: any): Promise<any> {
    let objectUrl: string;
    let sourceUrl: string;

    if (NESTED_TYPES.has(args.type?.toUpperCase())) {
      try {
        const resolved = await this.resolveNestedUrl(args.name, args.type, args.fugr);
        objectUrl = resolved.objectUrl;
        sourceUrl = resolved.sourceUrl;
      } catch (error: any) {
        this.fail(formatError(`abap_set_source(${args.name}) resolve`, error));
      }
    } else {
      objectUrl = buildObjectUrl(args.name, args.type);
      sourceUrl = `${objectUrl}/source/main`;
    }
    let lockHandle: string | null = null;

    try {
      const lockResult = await this.withSession(() =>
        this.adtclient.lock(objectUrl)
      );
      lockHandle = lockResult.LOCK_HANDLE;

      await this.withSession(() =>
        this.adtclient.setObjectSource(sourceUrl, args.source, lockHandle!, args.transport)
      );

      await this.withSession(() =>
        this.adtclient.unLock(objectUrl, lockHandle!)
      );
      lockHandle = null;

      return this.success({
        message: `Source written. Call abap_activate(${args.name}, ${args.type}) to activate.`,
        name: args.name,
        type: args.type
      });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl, lockHandle); } catch (_) {}
      }
      // If the error is about a missing transport, elicit it from the user and retry
      const errMsg = (error?.message || '').toLowerCase();
      if (!args.transport && (errMsg.includes('transport') || errMsg.includes('correction') || errMsg.includes('request'))) {
        const input = await this.elicitForm(
          `abap_set_source(${args.name}): This object requires a transport. Which transport should the change be recorded on?`,
          {
            transport: {
              type: 'string',
              title: 'Transport',
              description: 'Transport request number (e.g. D25K900161)'
            }
          },
          ['transport']
        );
        if (input?.transport) {
          args.transport = input.transport;
          return this.handleSetSource(args); // retry with the transport
        }
      }
      this.fail(formatError(`abap_set_source(${args.name})`, error));
    }
  }

  private async handleGetFunctionGroup(args: any): Promise<any> {
    if (!args.name) {
      this.fail('abap_get_function_group requires name (function group name, e.g. /DSN/010BWE or ZBILLING).');
    }
    const fgroupName = args.name.toUpperCase();
    const fgroupEncoded = fgroupName.replace(/\//g, '%2f').toLowerCase();
    const fgroupUrl = `/sap/bc/adt/functions/groups/${fgroupEncoded}`;
    const objectStructureUrl = `${fgroupUrl}/objectstructure`;
    const sources: Record<string, string> = {};
    const errors: Record<string, string> = {};

    try {
      // Fetch the /objectstructure endpoint for this function group.
      // This returns an XML tree of abapsource:objectStructureElement children, each with
      // an atom:link href pointing to the source URL for includes (FUGR/I) and FMs (FUGR/FF).
      // The FUGR base URL only returns top-level navigation links (versions, objectstructure link, etc.)
      // and does NOT contain the include/FM hrefs — those are only in /objectstructure.
      const h = (this.adtclient as any).h;
      const response = await this.withSession(async () =>
        h.request(objectStructureUrl, { headers: { Accept: '*/*' } })
      ) as any;

      const rawXml: string = response.body || '';

      // Parse atom:link hrefs from the objectStructureElement children.
      // Includes:  href matches /includes/...
      // FMs:       href matches /fmodules/.../source/main (no fragment)
      // Skip entries with a fragment (#type=...) — those are sub-symbols within an include, not the include itself.
      const seen = new Set<string>();
      const links: Array<{ name: string; sourceUrl: string }> = [];

      // Match all href values in atom:link elements
      const hrefRegex = /href="([^"#]+\/(?:includes|fmodules)\/[^"#]+\/source\/main)"/g;
      let m: RegExpExecArray | null;
      while ((m = hrefRegex.exec(rawXml)) !== null) {
        const href = m[1];
        if (seen.has(href)) continue;
        seen.add(href);
        // Derive a readable name from the URL (last path segment before /source/main)
        const nameMatch = href.match(/\/(?:includes|fmodules)\/([^/]+)\/source\/main$/);
        const name = nameMatch
          ? decodeURIComponent(nameMatch[1]).toUpperCase()
          : href;
        // Make sure href is absolute
        const sourceUrl = href.startsWith('/') ? href : `/${href}`;
        links.push({ name, sourceUrl });
      }

      // Fetch source for each include and FM in parallel
      await Promise.all(links.map(async ({ name, sourceUrl }) => {
        try {
          const src = await this.withSession(() =>
            this.adtclient.getObjectSource(sourceUrl)
          );
          sources[name] = src as string;
        } catch (e: any) {
          errors[name] = e.message || 'Unknown error';
        }
      }));

      return this.success({
        functionGroup: fgroupName,
        includeCount: Object.keys(sources).length,
        sources,
        errors: Object.keys(errors).length > 0 ? errors : undefined
      });
    } catch (error: any) {
      this.fail(formatError(`abap_get_function_group(${args.name})`, error));
    }
  }
}
