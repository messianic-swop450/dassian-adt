import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { buildObjectUrl } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';
import type { UnitTestClass, UnitTestRunFlags } from 'abap-adt-api';

export class TestHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_create_test_include',
        description:
          'Scaffold a test class include (CCAU) for an existing ABAP class. ' +
          'Creates the test include if it does not already exist, preparing the class for ABAP Unit tests. ' +
          'After creation, use abap_set_class_include(include_type="testclasses") to write your test code.',
        inputSchema: {
          type: 'object',
          properties: {
            name:      { type: 'string', description: 'Class name, e.g. /DSN/CL_MY_CLASS' },
            transport: { type: 'string', description: 'Transport number. Required for classes outside $TMP.' }
          },
          required: ['name']
        }
      },
      {
        name: 'abap_unit_test',
        description:
          'Run ABAP Unit tests for an object and return pass/fail results. ' +
          'Returns a summary (total/passed/failed/errors) plus per-method detail for failures. ' +
          'Failed tests include the assertion message, details, and stack trace with source locations. ' +
          'Supports classes (CLAS) and programs (PROG/P) that contain local test classes.',
        inputSchema: {
          type: 'object',
          properties: {
            name:     { type: 'string', description: 'Object name (e.g. /DSN/CL_MY_CLASS)' },
            type:     { type: 'string', description: 'Object type — CLAS or PROG/P (default: CLAS)' },
            risk:     { type: 'string', description: 'Risk level filter: harmless, dangerous, critical, or all (default: all)', enum: ['harmless', 'dangerous', 'critical', 'all'] },
            duration: { type: 'string', description: 'Duration filter: short, medium, long, or all (default: all)', enum: ['short', 'medium', 'long', 'all'] }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_create_test_include': return this.handleCreateTestInclude(args);
      case 'abap_unit_test':           return this.handleUnitTest(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleCreateTestInclude(args: any): Promise<any> {
    const objectUrl = buildObjectUrl(args.name, 'CLAS');
    let lockHandle: string | null = null;
    try {
      await this.withSession(async () => {
        const r = await this.adtclient.lock(objectUrl);
        lockHandle = r.LOCK_HANDLE;
        const transport = args.transport || r.CORRNR || '';
        try {
          await this.adtclient.createTestInclude(args.name, lockHandle!, transport || undefined);
        } catch (err: any) {
          try { await this.adtclient.unLock(objectUrl, lockHandle!); } catch (_) {}
          lockHandle = null;
          throw err;
        }
        await this.adtclient.unLock(objectUrl, lockHandle!);
        lockHandle = null;
      });
      return this.success({
        message: `Test include created for ${args.name}. Use abap_set_class_include(include_type="testclasses") to write tests.`,
        name: args.name
      });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl, lockHandle); } catch (_) {}
      }
      const errMsg = (error?.message || '').toLowerCase();
      if (!args.transport && (errMsg.includes('transport') || errMsg.includes('correction') || errMsg.includes('request'))) {
        const input = await this.elicitForm(
          `abap_create_test_include(${args.name}): This class requires a transport. Which transport?`,
          { transport: { type: 'string', title: 'Transport', description: 'Transport request number (e.g. D25K900161)' } },
          ['transport']
        );
        if (input?.transport) {
          args.transport = input.transport;
          return this.handleCreateTestInclude(args);
        }
      }
      this.fail(formatError(`abap_create_test_include(${args.name})`, error));
    }
  }

  private async handleUnitTest(args: any): Promise<any> {
    const type = args.type || 'CLAS';
    const objectUrl = buildObjectUrl(args.name, type);

    const flags: UnitTestRunFlags = {
      harmless: args.risk === 'harmless' || !args.risk || args.risk === 'all',
      dangerous: args.risk === 'dangerous' || !args.risk || args.risk === 'all',
      critical:  args.risk === 'critical'  || !args.risk || args.risk === 'all',
      short:     args.duration === 'short'  || !args.duration || args.duration === 'all',
      medium:    args.duration === 'medium' || !args.duration || args.duration === 'all',
      long:      args.duration === 'long'   || !args.duration || args.duration === 'all',
    };

    try {
      await this.notify(`Running unit tests on ${args.name}…`);
      const classes = await this.withSession(() =>
        this.adtclient.unitTestRun(objectUrl, flags)
      ) as UnitTestClass[];

      if (!classes || classes.length === 0) {
        return this.success({
          name: args.name,
          summary: { total: 0, passed: 0, failed: 0, errors: 0 },
          note: 'No test classes found. Ensure the object contains local test classes (CLASS ... FOR TESTING).'
        });
      }

      let total = 0, passed = 0, failed = 0, errors = 0;
      const classResults: any[] = [];

      for (const cls of classes) {
        const methods = cls.testmethods || [];
        const classAlerts = cls.alerts || [];
        const methodResults: any[] = [];

        for (const method of methods) {
          total++;
          const alerts = method.alerts || [];
          const hasFail = alerts.some(a => a.kind === 'failedAssertion');
          const hasError = alerts.some(a => a.kind === 'exception');

          if (hasError)       errors++;
          else if (hasFail)   failed++;
          else                passed++;

          if (alerts.length > 0) {
            methodResults.push({
              method: method['adtcore:name'],
              executionTime: method.executionTime,
              status: hasError ? 'error' : hasFail ? 'failed' : 'passed',
              alerts: alerts.map(a => ({
                kind: a.kind,
                severity: a.severity,
                title: a.title,
                details: a.details,
                stack: a.stack?.map(s => ({
                  uri: s['adtcore:uri'],
                  name: s['adtcore:name'],
                  description: s['adtcore:description']
                }))
              }))
            });
          }
        }

        // Class-level alerts (setup/teardown failures)
        if (classAlerts.length > 0 && methodResults.length === 0) {
          errors++;
          total++;
        }

        classResults.push({
          class: cls['adtcore:name'],
          riskLevel: cls.riskLevel,
          durationCategory: cls.durationCategory,
          ...(methodResults.length > 0 ? { failures: methodResults } : {}),
          ...(classAlerts.length > 0 ? {
            classAlerts: classAlerts.map(a => ({ kind: a.kind, title: a.title, details: a.details }))
          } : {})
        });
      }

      const summary = { total, passed, failed, errors };
      const allPassed = failed === 0 && errors === 0;

      return this.success({
        name: args.name,
        summary,
        status: allPassed ? 'ALL PASSED' : `${failed + errors} FAILURE(S)`,
        classes: allPassed
          ? classResults.map(c => ({ class: c.class }))  // compact on full pass
          : classResults
      });
    } catch (error: any) {
      this.fail(formatError(`abap_unit_test(${args.name})`, error));
    }
  }
}
