// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express and Claude SDK client before tools.ts imports them.
import './tracing.js';
export * from './tools.js';
