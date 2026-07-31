/**
 * Hotel-service Express application factory.
 *
 * Mounts the hotel search router at /v1/hotels and wires the shared error
 * handler so all unhandled exceptions produce the standard envelope.
 */

import express from 'express';
import { createErrorHandler } from '../../../shared/middleware/errorHandler.js';
import { createHotelSearchRouter } from './routes/hotelSearchRoutes.js';
import type { IHotelSearchService } from './domain/HotelSearchService.js';
import type { HealthHandlers } from '@travel/observability';

export interface HotelAppOptions {
  hotelSearchService: IHotelSearchService;
  healthHandlers?: HealthHandlers;
}

export function createApp(options: HotelAppOptions): express.Application {
  const { hotelSearchService, healthHandlers } = options;

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.use('/v1/hotels', createHotelSearchRouter({ hotelSearchService }));

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
