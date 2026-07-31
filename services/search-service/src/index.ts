// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express and supplier HTTP clients before app.ts imports them.
import './tracing.js';
export { createApp } from './app.js';
