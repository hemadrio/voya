/**
 * flight-service Express application factory.
 *
 * Mounts the flight search router at /v1/flights and wires the shared error
 * handler so all unhandled exceptions produce the standard envelope.
 *
 * Health endpoints are explicitly exempted from validation middleware.
 */

import express from 'express';
import { createErrorHandler } from '../../../shared/middleware/errorHandler.js';
import { createFlightSearchRouter } from './routes/flightSearchRoutes.js';
import type { IFlightSearchService } from './domain/FlightSearchService.js';
import type { HealthHandlers } from '@travel/observability';

export interface FlightAppOptions {
  flightSearchService: IFlightSearchService;
  healthHandlers?: HealthHandlers;
}

export function createApp(options: FlightAppOptions): express.Application {
  const { flightSearchService, healthHandlers } = options;

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Flight search routes
  app.use('/v1/flights', createFlightSearchRouter({ flightSearchService }));

  // Health endpoints — no auth, no validation
  if (healthHandlers !== undefined) {
    app.get('/health/live', healthHandlers.liveHandler.bind(healthHandlers));
    app.get('/health/ready', (req, res, next) => {
      (healthHandlers.readyHandler(req, res) as Promise<unknown>).catch(next);
    });
  } else {
    app.get('/health/live', (_req, res) =>
      res.json({ status: 'alive', uptimeSeconds: Math.floor(process.uptime()) }),
    );
    app.get('/health/ready', (_req, res) => res.json({ status: 'ok' }));
  }

  app.use(createErrorHandler());

  return app;
}
