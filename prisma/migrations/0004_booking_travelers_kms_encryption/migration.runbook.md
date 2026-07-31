# Migration Runbook: 0004_booking_travelers_kms_encryption

## WO-073 — Normalize Traveler Identity Documents with KMS Envelope Encryption

### Pre-migration checklist
- [ ] CMK provisioned in Terraform (`alias/<env>/platform/traveler-identity`)
- [ ] `CMK_ARN` env var set for booking-service ECS task
- [ ] Booking-service IAM task role has `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey` on the CMK
- [ ] Backfill IAM task role has `kms:Encrypt`, `kms:GenerateDataKey` on the CMK; Decrypt explicitly denied
- [ ] `support_agent` DB role exists (migration contains a conditional REVOKE)
- [ ] `booking_service` DB role exists (migration contains a conditional GRANT)
- [ ] Staging backfill rehearsed against anonymised dataset

### Migration steps
1. `prisma migrate deploy` — applies the additive migration
2. Verify `booking_travelers` table created with correct columns
3. Verify `travelers_migrated_at` column added to `bookings`
4. Verify `support_agent` cannot SELECT `encrypted_date_of_birth` / `encrypted_passport_reference`:
   ```sql
   SET ROLE support_agent;
   SELECT encrypted_date_of_birth FROM booking_travelers LIMIT 1;
   -- Expected: ERROR: permission denied for column encrypted_date_of_birth
   RESET ROLE;
   ```

### Backfill
```bash
BATCH_SIZE=100 MAX_CONCURRENCY=5 CMK_ARN=<arn> DATABASE_URL=<url> \
  tsx scripts/backfill-booking-travelers.ts
```

### Reconciliation gate (must pass before contract migration)
```bash
DATABASE_URL=<url> tsx scripts/reconcile-booking-travelers.ts
# Exit 0 = pass, exit 1 = fail (mismatches logged to stdout)
```

### Resume after interruption
Re-run the backfill script with the same arguments — it uses `travelers_migrated_at IS NULL`
as the cursor and skips already-migrated bookings.

### Rollback
This migration is additive — no data is dropped. To roll back:
1. Deploy the previous service version (it ignores the new columns)
2. The `travelers_migrated_at` column is nullable and defaults to NULL
3. The `booking_travelers` table can be truncated if the backfill needs to be re-run
   (all data is re-encryptable from the legacy `passengers` column)

### Post-migration: feature flag
Set the `READ_FROM_BOOKING_TRAVELERS` feature flag to `true` to enable the new read path
progressively. The legacy `passengers` column remains writable and readable until the
contract migration story drops it.
