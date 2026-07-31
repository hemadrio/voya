// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express before app.ts imports it.
import './tracing.js';
export { createApp } from './app.js';
