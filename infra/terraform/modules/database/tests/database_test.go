package test

import (
	"encoding/json"
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// planVars provides the minimum required variables for a plan-only run.
// Real ARNs/IDs are not resolved at plan time, so dummy values are fine.
var planVars = map[string]interface{}{
	"environment":              "staging",
	"aws_account_id":           "123456789012",
	"aws_region":               "eu-west-1",
	"vpc_id":                   "vpc-00000000000000001",
	"private_data_subnet_ids":  []string{"subnet-00000000000000001", "subnet-00000000000000002"},
	"service_sg_id":            "sg-00000000000000001",
	"kms_key_arn":              "arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-0000-0000-000000000001",
	"alarm_sns_arn":            "arn:aws:sns:eu-west-1:123456789012:staging-travel-platform-alarms",
	"deletion_protection":      false,
	"backup_retention_days":    35,
}

// TestDatabaseModulePlan verifies the Terraform plan for the database module
// satisfies all WO-083 acceptance criteria without requiring live AWS credentials.
func TestDatabaseModulePlan(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../",
		Vars:         planVars,
		PlanFilePath: "/tmp/database-module-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct, "terraform plan must produce a non-nil plan struct")

	rdsChanges := planStruct.ResourceChangesMap

	// ── RDS instance — Multi-AZ, encryption, PITR ──────────────────────────

	t.Run("RDS_MultiAZ_enabled", func(t *testing.T) {
		rds, ok := rdsChanges["aws_db_instance.main"]
		require.True(t, ok, "aws_db_instance.main must be in plan")

		after := mustDecodeAfter(t, rds.Change.After)
		assert.Equal(t, true, after["multi_az"], "multi_az must be true (HA requirement)")
	})

	t.Run("RDS_backup_retention_35_days", func(t *testing.T) {
		rds, ok := rdsChanges["aws_db_instance.main"]
		require.True(t, ok, "aws_db_instance.main must be in plan")

		after := mustDecodeAfter(t, rds.Change.After)
		// planVars sets backup_retention_days=35; verify the plan reflects it.
		ret := toFloat64(after["backup_retention_period"])
		assert.Equal(t, float64(35), ret, "backup_retention_period must be 35 days (~15 min RPO via WAL + PITR)")
	})

	t.Run("RDS_storage_encrypted_with_KMS", func(t *testing.T) {
		rds, ok := rdsChanges["aws_db_instance.main"]
		require.True(t, ok, "aws_db_instance.main must be in plan")

		after := mustDecodeAfter(t, rds.Change.After)
		assert.Equal(t, true, after["storage_encrypted"], "storage_encrypted must be true")
		assert.NotEmpty(t, after["kms_key_id"], "kms_key_id must be set to the RDS CMK")
	})

	t.Run("RDS_managed_master_password", func(t *testing.T) {
		rds, ok := rdsChanges["aws_db_instance.main"]
		require.True(t, ok, "aws_db_instance.main must be in plan")

		after := mustDecodeAfter(t, rds.Change.After)
		assert.Equal(t, true, after["manage_master_user_password"],
			"manage_master_user_password must be true — RDS rotates credentials in Secrets Manager")
	})

	t.Run("RDS_performance_insights_enabled", func(t *testing.T) {
		rds, ok := rdsChanges["aws_db_instance.main"]
		require.True(t, ok, "aws_db_instance.main must be in plan")

		after := mustDecodeAfter(t, rds.Change.After)
		assert.Equal(t, true, after["performance_insights_enabled"])
	})

	// ── Cross-region backup replication ────────────────────────────────────

	t.Run("RDS_cross_region_backup_replication_exists", func(t *testing.T) {
		_, ok := rdsChanges["aws_db_instance_automated_backups_replication.dr"]
		assert.True(t, ok,
			"aws_db_instance_automated_backups_replication.dr must be in plan (DR requirement)")
	})

	// ── RDS Proxy — IAM auth, TLS ───────────────────────────────────────────
	// The proxy module is instantiated by the env root module, not the database
	// module itself. The database module's outputs feed the proxy. We verify the
	// database module exposes the outputs the proxy module requires.

	t.Run("Database_module_exposes_master_user_secret_arn", func(t *testing.T) {
		_, ok := planStruct.PlannedValues.Outputs["master_user_secret_arn"]
		assert.True(t, ok,
			"master_user_secret_arn output must exist so rds-proxy can consume it")
	})

	t.Run("Database_module_exposes_rds_security_group_id", func(t *testing.T) {
		_, ok := planStruct.PlannedValues.Outputs["rds_security_group_id"]
		assert.True(t, ok,
			"rds_security_group_id output must exist so rds-proxy can modify ingress rules")
	})

	// ── CloudWatch alarms ───────────────────────────────────────────────────

	t.Run("RDS_CPU_alarm_threshold_80pct", func(t *testing.T) {
		alarm, ok := rdsChanges["aws_cloudwatch_metric_alarm.rds_cpu"]
		require.True(t, ok, "aws_cloudwatch_metric_alarm.rds_cpu must be in plan")

		after := mustDecodeAfter(t, alarm.Change.After)
		assert.Equal(t, float64(80), toFloat64(after["threshold"]),
			"CPU alarm threshold must be 80%%")
	})

	t.Run("RDS_enhanced_monitoring_role_exists", func(t *testing.T) {
		_, ok := rdsChanges["aws_iam_role.rds_enhanced_monitoring"]
		assert.True(t, ok, "aws_iam_role.rds_enhanced_monitoring must be in plan")
	})
}

// TestSQSFIFOQueueAttributes verifies WO-083 FIFO queue design in the sqs module.
func TestSQSFIFOQueueAttributes(t *testing.T) {
	t.Parallel()

	sqsVars := map[string]interface{}{
		"environment":  "staging",
		"kms_key_arn":  "arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-0000-0000-000000000002",
		"alarm_sns_arn": "arn:aws:sns:eu-west-1:123456789012:staging-travel-platform-alarms",
	}

	opts := &terraform.Options{
		TerraformDir: "../../sqs",
		Vars:         sqsVars,
		PlanFilePath: "/tmp/sqs-module-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct)

	changes := planStruct.ResourceChangesMap

	queues := []struct {
		resource string
		label    string
	}{
		{"aws_sqs_queue.booking_events", "booking-events"},
		{"aws_sqs_queue.payment_events", "payment-events"},
	}

	for _, q := range queues {
		q := q
		t.Run(q.label+"_FIFO_deduplication_scope_messageGroup", func(t *testing.T) {
			res, ok := changes[q.resource]
			require.True(t, ok, "%s must be in plan", q.resource)

			after := mustDecodeAfter(t, res.Change.After)
			assert.Equal(t, "messageGroup", after["deduplication_scope"],
				"deduplication_scope must be messageGroup — prevents silent cross-group dedup")
			assert.Equal(t, "perMessageGroupId", after["fifo_throughput_limit"],
				"fifo_throughput_limit must be perMessageGroupId")
			assert.Equal(t, false, after["content_based_deduplication"],
				"content_based_deduplication must be false — app supplies explicit MessageDeduplicationId")
		})
	}

	dlqs := []struct {
		resource     string
		sourceQueue  string
		label        string
	}{
		{"aws_sqs_queue.booking_events_dlq", "aws_sqs_queue.booking_events", "booking-events-dlq"},
		{"aws_sqs_queue.payment_events_dlq", "aws_sqs_queue.payment_events", "payment-events-dlq"},
		{"aws_sqs_queue.notifications_dlq", "aws_sqs_queue.notifications", "notifications-dlq"},
	}

	for _, d := range dlqs {
		d := d
		t.Run(d.label+"_redrive_maxReceiveCount_5", func(t *testing.T) {
			src, ok := changes[d.sourceQueue]
			require.True(t, ok, "%s must be in plan", d.sourceQueue)

			after := mustDecodeAfter(t, src.Change.After)
			redriveRaw, ok := after["redrive_policy"]
			require.True(t, ok && redriveRaw != nil, "%s must have a redrive_policy", d.sourceQueue)

			var redrive map[string]interface{}
			require.NoError(t, json.Unmarshal([]byte(redriveRaw.(string)), &redrive))
			assert.Equal(t, float64(5), toFloat64(redrive["maxReceiveCount"]),
				"maxReceiveCount must be 5 before DLQ promotion")
		})
	}
}

// TestSecretsRotationSchedule verifies rotation cadence <= 90 days.
func TestSecretsRotationSchedule(t *testing.T) {
	t.Parallel()

	secretsVars := map[string]interface{}{
		"environment":         "staging",
		"kms_key_arn":         "arn:aws:kms:eu-west-1:123456789012:key/00000000-0000-0000-0000-000000000003",
		"rotation_days":       90,
		"rotation_lambda_arn": "arn:aws:lambda:eu-west-1:123456789012:function:travel-secret-rotation",
	}

	opts := &terraform.Options{
		TerraformDir: "../../secrets",
		Vars:         secretsVars,
		PlanFilePath: "/tmp/secrets-module-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct)

	for addr, change := range planStruct.ResourceChangesMap {
		if change.Type != "aws_secretsmanager_secret_rotation" {
			continue
		}

		t.Run(addr+"_rotation_within_90_days", func(t *testing.T) {
			after := mustDecodeAfter(t, change.Change.After)
			rulesRaw, ok := after["rotation_rules"]
			require.True(t, ok, "rotation_rules must be present on %s", addr)

			rulesSlice, ok := rulesRaw.([]interface{})
			require.True(t, ok && len(rulesSlice) > 0, "rotation_rules must be non-empty")

			rule, ok := rulesSlice[0].(map[string]interface{})
			require.True(t, ok)

			days := toFloat64(rule["automatically_after_days"])
			assert.LessOrEqual(t, days, float64(90),
				"rotation cadence must not exceed 90 days (security policy)")
		})
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func mustDecodeAfter(t *testing.T, raw interface{}) map[string]interface{} {
	t.Helper()
	if m, ok := raw.(map[string]interface{}); ok {
		return m
	}
	b, err := json.Marshal(raw)
	require.NoError(t, err)
	var out map[string]interface{}
	require.NoError(t, json.Unmarshal(b, &out))
	return out
}

func toFloat64(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
