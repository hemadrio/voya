-- Destructive fixture: TYPE CHANGE (type narrowing)
-- Changing total_price from DECIMAL(12,2) to DECIMAL(8,2) narrows the column.
-- The old application code may have written values > 99999999.99 which will
-- fail to insert after this migration runs.

ALTER TABLE bookings ALTER COLUMN total_price TYPE DECIMAL(8,2);
