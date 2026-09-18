// zcode-backend.js - ZCode desktop Agent backend implementation.
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * ZCode currently documents a desktop Agent and built-in Agent tool, not a
 * public headless CLI. Dispatch therefore stays in the main session, matching
 * the Claude/CodeBuddy backend contract instead of spawning a guessed command.
 */
export class ZcodeBackend {
  constructor() {
    this.type = 'zcode';
    this.name = 'ZCode';
    this.version = 'unknown';
  }

  detect() {
    return process.env.HARNESS_BACKEND?.toLowerCase() === 'zcode' ||
      Boolean(process.env.ZCODE_PLUGIN_ROOT);
  }

  getSessionId() {
    // The public documentation does not define a stable session environment variable.
    return null;
  }

  getDataDir() {
    return process.env.ZCODE_PLUGIN_DATA || join(homedir(), '.zcode', 'uni-auri');
  }

  async dispatchSubAgent(role, prompt, options = {}) {
    return {
      exitStatus: 'PENDING',
      message: 'Please use the ZCode Agent tool with the prepared prompt',
      role,
      prompt,
      options,
    };
  }

  async injectRules() {
    return true;
  }

  async enforceGates() {
    return { allowed: true, note: 'Gate enforcement handled by the enabled Uni-AURI ZCode plugin' };
  }

  async recordUsage() {
    // Dispatch timing is recorded by plugin Hooks. No stable token schema is documented.
  }

  getTranscriptPath() {
    // Hook transcript_path is explicitly temporary and is deleted after the Hook finishes.
    return null;
  }

  extractTokenUsage() {
    return null;
  }
}

export default ZcodeBackend;
