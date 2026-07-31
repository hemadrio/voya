/**
 * PartitionMaintenance — automated monthly partition pre-creation and
 * hot/cold boundary management for booking_audit_log.
 *
 * Hot boundary: current month plus the preceding 11 months (12 months total).
 * Cold boundary: partitions older than 12 months are detached from the hot
 *   set into a cold partition set but are NOT dropped — they remain queryable
 *   for the at-least-one-year audit retention obligation.
 *
 * Pre-creation: N months of future partitions are created before they are
 * needed so an insert never lands in the default partition due to a race
 * between the clock and the maintenance task.
 *
 * Usage (scheduled via cron / ECS scheduled task):
 *   const maintenance = createPartitionMaintenance({ db, logger });
 *   const report = await maintenance.run();
 *
 * An alarm fires via CloudWatch if the next required partition does not exist
 * ahead of need.  The maintenance task emits a structured warning log that
 * can be monitored via a CloudWatch Logs metric filter.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal Postgres client interface — injected to avoid a direct dependency. */
export interface PartitionDbClient {
  /** Execute a raw SQL statement. Returns void. */
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown>;
  /** Query returning typed rows. */
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T[]>;
}

export interface PartitionMaintenanceLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PartitionMaintenanceOptions {
  db: PartitionDbClient;
  logger: PartitionMaintenanceLogger;
  /** Number of future months to pre-create (default: 3). */
  preCreateMonths?: number;
  /** Hot boundary in months: partitions older than this are cold (default: 12). */
  hotBoundaryMonths?: number;
  /** Table name being maintained (default: booking_audit_log). */
  tableName?: string;
}

export interface PartitionMaintenanceReport {
  created: string[];
  alreadyExisted: string[];
  movedToCold: string[];
  missingNextPartition: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthLabel(year: number, month: number): string {
  const m = String(month).padStart(2, "0");
  return `${year}_${m}`;
}

function partitionName(tableName: string, year: number, month: number): string {
  return `${tableName}_${monthLabel(year, month)}`;
}

/** Returns the first day of a given year+month as an ISO date string. */
function monthStart(year: number, month: number): string {
  const m = String(month).padStart(2, "0");
  return `${year}-${m}-01`;
}

/** Returns the first day of the following month. */
function monthEnd(year: number, month: number): string {
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return monthStart(next.y, next.m);
}

/** Adds N months to a {year, month} tuple. */
function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const total = (year * 12 + month - 1) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** Subtracts N months from a {year, month} tuple. */
function subtractMonths(year: number, month: number, n: number): { year: number; month: number } {
  return addMonths(year, month, -n);
}

// ---------------------------------------------------------------------------
// PartitionMaintenance
// ---------------------------------------------------------------------------

export interface PartitionMaintenance {
  run(now?: Date): Promise<PartitionMaintenanceReport>;
}

export function createPartitionMaintenance(
  opts: PartitionMaintenanceOptions,
): PartitionMaintenance {
  const {
    db,
    logger,
    preCreateMonths = 3,
    hotBoundaryMonths = 12,
    tableName = "booking_audit_log",
  } = opts;

  async function existingPartitions(): Promise<Set<string>> {
    type Row = { partition_name: string };
    const rows = await db.$queryRawUnsafe<Row>(
      `SELECT c.relname AS partition_name
         FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE p.relname = $1
          AND n.nspname = current_schema()`,
      tableName,
    );
    return new Set(rows.map((r) => r.partition_name));
  }

  async function createPartition(
    name: string,
    start: string,
    end: string,
  ): Promise<void> {
    await db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS ${name}
         PARTITION OF ${tableName}
         FOR VALUES FROM ('${start}'::TIMESTAMPTZ) TO ('${end}'::TIMESTAMPTZ)`,
    );
  }

  async function detachToDefault(name: string): Promise<void> {
    // Detach from the main parent; data is preserved and queryable
    // via booking_audit_log_cold_<name> or direct table scan.
    // We rename rather than drop so audit data is never lost.
    const coldName = name.replace(tableName, `${tableName}_cold`);
    await db.$executeRawUnsafe(
      `ALTER TABLE ${tableName} DETACH PARTITION ${name} CONCURRENTLY`,
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE ${name} RENAME TO ${coldName}`,
    );
  }

  return {
    async run(now = new Date()): Promise<PartitionMaintenanceReport> {
      const report: PartitionMaintenanceReport = {
        created: [],
        alreadyExisted: [],
        movedToCold: [],
        missingNextPartition: false,
        errors: [],
      };

      const currentYear = now.getUTCFullYear();
      const currentMonth = now.getUTCMonth() + 1; // 1-indexed

      let existing: Set<string>;
      try {
        existing = await existingPartitions();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(`Failed to list existing partitions: ${msg}`);
        logger.error({ event: "partition.maintenance.error", error: msg }, "Failed to list partitions");
        return report;
      }

      // ── Pre-create future partitions ─────────────────────────────────────
      for (let i = 0; i <= preCreateMonths; i++) {
        const { year, month } = addMonths(currentYear, currentMonth, i);
        const name = partitionName(tableName, year, month);

        if (existing.has(name)) {
          report.alreadyExisted.push(name);
          continue;
        }

        try {
          await createPartition(name, monthStart(year, month), monthEnd(year, month));
          report.created.push(name);
          logger.info(
            { event: "partition.created", partition: name },
            `Pre-created partition ${name}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          report.errors.push(`Failed to create partition ${name}: ${msg}`);
          logger.error(
            { event: "partition.create.error", partition: name, error: msg },
            `Failed to create partition ${name}`,
          );
        }
      }

      // ── Check the next partition exists (alarm signal) ───────────────────
      const { year: nextYear, month: nextMonth } = addMonths(currentYear, currentMonth, 1);
      const nextPartitionName = partitionName(tableName, nextYear, nextMonth);
      if (!existing.has(nextPartitionName) && !report.created.includes(nextPartitionName)) {
        report.missingNextPartition = true;
        logger.warn(
          {
            event: "partition.missing_next",
            partition: nextPartitionName,
            alertable: true,
          },
          `Next month partition ${nextPartitionName} is missing — CloudWatch alarm should fire`,
        );
      }

      // ── Detach cold partitions ────────────────────────────────────────────
      const { year: coldYear, month: coldMonth } = subtractMonths(
        currentYear,
        currentMonth,
        hotBoundaryMonths,
      );

      for (const partName of existing) {
        if (!partName.startsWith(tableName + "_")) continue;
        // Skip the default partition
        if (partName === `${tableName}_default`) continue;

        // Extract YYYY_MM from partition name
        const suffix = partName.slice(tableName.length + 1);
        const match = suffix.match(/^(\d{4})_(\d{2})$/);
        if (!match) continue;

        const pYear = parseInt(match[1]!, 10);
        const pMonth = parseInt(match[2]!, 10);

        // If partition is older than the cold boundary, move it
        const olderThanBoundary =
          pYear < coldYear || (pYear === coldYear && pMonth < coldMonth);

        if (olderThanBoundary) {
          try {
            await detachToDefault(partName);
            report.movedToCold.push(partName);
            logger.info(
              { event: "partition.moved_to_cold", partition: partName },
              `Partition ${partName} detached to cold storage`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            report.errors.push(`Failed to detach partition ${partName}: ${msg}`);
            logger.error(
              { event: "partition.detach.error", partition: partName, error: msg },
              `Failed to detach partition ${partName}`,
            );
          }
        }
      }

      logger.info(
        {
          event: "partition.maintenance.complete",
          created: report.created.length,
          alreadyExisted: report.alreadyExisted.length,
          movedToCold: report.movedToCold.length,
          missingNextPartition: report.missingNextPartition,
          errors: report.errors.length,
        },
        "Partition maintenance complete",
      );

      return report;
    },
  };
}
