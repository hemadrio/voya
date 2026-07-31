// Port interface
export type {
  AckHandle,
  MessageHandler,
  SubscribeOptions,
  QueuePort,
} from "./QueuePort.js";

// Validation error
export { QueueValidationError, isQueueValidationError } from "./QueueValidationError.js";

// Adapters
export type { AmqpConnection, AmqpChannel, AmqpMessage, RabbitMqAdapterOptions } from "./adapters/RabbitMqAdapter.js";
export { RabbitMqAdapter } from "./adapters/RabbitMqAdapter.js";

export type { SqsAdapterOptions } from "./adapters/SqsAdapter.js";
export { SqsAdapter } from "./adapters/SqsAdapter.js";

// Factory
export type { QueueDriver, CreateQueueAdapterOptions } from "./factory.js";
export { createQueueAdapter } from "./factory.js";
