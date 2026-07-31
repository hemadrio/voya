// Package test contains Terratest plan assertions for the ecs-service module's
// autoscaling resources (WO-082).
//
// Tests verify (without live AWS credentials):
//   - Autoscaling target min/max capacity per service class
//   - CPU target-tracking policy: target_value=60, asymmetric cooldowns
//   - ALB step-scaling policy: PercentChangeInCapacity=100, period=60, eval_periods=2
//   - Notification-consumer scaling uses SQS ApproximateNumberOfMessagesVisible
//   - No CPU policy exists for the consumer service
//
// Prerequisites:
//
//	go mod init travel-platform/ecs-service-tests
//	go get github.com/gruntwork-io/terratest/modules/terraform@v0.46.0
//	go get github.com/stretchr/testify@v1.9.0
//
// Run:
//
//	cd infra/terraform/modules/ecs-service/tests
//	go test -v -timeout 10m -run TestEcsServiceAutoscaling
package test

import (
	"encoding/json"
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// baseVars satisfies all required module inputs for a plan-only run.
// ARNs and IDs are plausible dummies — they are not resolved during plan.
var baseVars = map[string]interface{}{
	"environment":        "staging",
	"service_name":       "flight-service",
	"container_image":    "123456789012.dkr.ecr.eu-west-1.amazonaws.com/flight-service:latest",
	"aws_account_id":     "123456789012",
	"aws_region":         "eu-west-1",
	"log_group_name":     "/ecs/staging/flight-service",
	"ecs_cluster_arn":    "arn:aws:ecs:eu-west-1:123456789012:cluster/staging-travel-platform",
	"subnet_ids":         []string{"subnet-12345678"},
	"security_group_ids": []string{"sg-12345678"},
	"port":               3003,
}

// searchServiceAutoscalingVars extends baseVars with search-service autoscaling settings.
func searchServiceAutoscalingVars() map[string]interface{} {
	vars := copyVars(baseVars)
	vars["enable_autoscaling"] = true
	vars["cluster_name"] = "staging-travel-platform"
	vars["autoscaling_min_capacity"] = 3
	vars["autoscaling_max_capacity"] = 20
	vars["enable_request_scaling"] = true
	vars["target_group_arn"] = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/flight-service/abcdef1234567890"
	vars["autoscaling_request_threshold"] = 1000
	vars["autoscaling_request_alarm_period"] = 60
	vars["autoscaling_request_eval_periods"] = 2
	vars["autoscaling_step_cooldown"] = 120
	vars["autoscaling_step_min_adjustment"] = 1
	vars["autoscaling_cpu_target"] = 60
	vars["autoscaling_scale_out_cooldown"] = 60
	vars["autoscaling_scale_in_cooldown"] = 300
	return vars
}

// apiGatewayAutoscalingVars extends baseVars with api-gateway autoscaling settings.
func apiGatewayAutoscalingVars() map[string]interface{} {
	vars := copyVars(baseVars)
	vars["service_name"] = "api-gateway"
	vars["port"] = 3000
	vars["enable_autoscaling"] = true
	vars["cluster_name"] = "staging-travel-platform"
	vars["autoscaling_min_capacity"] = 4
	vars["autoscaling_max_capacity"] = 24
	vars["enable_request_scaling"] = true
	vars["target_group_arn"] = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/api-gateway/abcdef1234567890"
	vars["autoscaling_request_threshold"] = 1000
	vars["autoscaling_cpu_target"] = 60
	vars["autoscaling_scale_out_cooldown"] = 60
	vars["autoscaling_scale_in_cooldown"] = 300
	return vars
}

// consumerAutoscalingVars extends baseVars with notification-consumer SQS-based scaling.
func consumerAutoscalingVars() map[string]interface{} {
	vars := copyVars(baseVars)
	vars["service_name"] = "notification-consumer"
	vars["port"] = 3009
	vars["enable_autoscaling"] = true
	vars["cluster_name"] = "staging-travel-platform"
	vars["autoscaling_min_capacity"] = 3
	vars["autoscaling_max_capacity"] = 20
	vars["consumer_scaling_queue_name"] = "staging-notifications"
	vars["consumer_scale_out_threshold"] = 100
	vars["consumer_scale_in_threshold"] = 20
	return vars
}

// ── AC1/AC2: Search service autoscaling target — min 3 / max 20 ───────────────

// TestEcsServiceAutoscaling_SearchService_MinMax verifies the App Auto Scaling
// target is planned with the correct min/max for search services.
func TestEcsServiceAutoscaling_SearchService_MinMax(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../",
		Vars:         searchServiceAutoscalingVars(),
		PlanFilePath: "/tmp/ecs-autoscaling-search-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct)

	changes := planStruct.ResourceChangesMap

	t.Run("autoscaling_target_exists", func(t *testing.T) {
		_, ok := changes["aws_appautoscaling_target.this[0]"]
		assert.True(t, ok, "aws_appautoscaling_target.this[0] must be in plan for search service")
	})

	t.Run("min_capacity_3", func(t *testing.T) {
		tgt, ok := changes["aws_appautoscaling_target.this[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, tgt.Change.After)
		assert.Equal(t, float64(3), toFloat64AS(after["min_capacity"]),
			"Search service min_capacity must be 3 (WO-082 AC1)")
	})

	t.Run("max_capacity_20", func(t *testing.T) {
		tgt, ok := changes["aws_appautoscaling_target.this[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, tgt.Change.After)
		assert.Equal(t, float64(20), toFloat64AS(after["max_capacity"]),
			"Search service max_capacity must be 20 (WO-082 AC1)")
	})

	t.Run("scalable_dimension_ecs", func(t *testing.T) {
		tgt, ok := changes["aws_appautoscaling_target.this[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, tgt.Change.After)
		assert.Equal(t, "ecs:service:DesiredCount", after["scalable_dimension"],
			"scalable_dimension must be ecs:service:DesiredCount")
	})
}

// ── AC1: api-gateway autoscaling target — min 4 / max 24 ─────────────────────

// TestEcsServiceAutoscaling_ApiGateway_MinMax verifies api-gateway target has min 4 / max 24.
func TestEcsServiceAutoscaling_ApiGateway_MinMax(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../",
		Vars:         apiGatewayAutoscalingVars(),
		PlanFilePath: "/tmp/ecs-autoscaling-gateway-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct)

	changes := planStruct.ResourceChangesMap
	tgt, ok := changes["aws_appautoscaling_target.this[0]"]
	require.True(t, ok, "aws_appautoscaling_target.this[0] must be in plan for api-gateway")

	after := mustDecodeAfterAS(t, tgt.Change.After)

	assert.Equal(t, float64(4), toFloat64AS(after["min_capacity"]),
		"api-gateway min_capacity must be 4 (WO-082 AC1)")
	assert.Equal(t, float64(24), toFloat64AS(after["max_capacity"]),
		"api-gateway max_capacity must be 24 (WO-082 AC1)")
}

// ── AC2: CPU target-tracking — target_value=60, asymmetric cooldowns ──────────

// TestEcsServiceAutoscaling_CpuTargetTracking verifies the CPU policy uses
// target_value=60 and scale_in_cooldown > scale_out_cooldown.
func TestEcsServiceAutoscaling_CpuTargetTracking(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../",
		Vars:         searchServiceAutoscalingVars(),
		PlanFilePath: "/tmp/ecs-autoscaling-cpu-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct)
	changes := planStruct.ResourceChangesMap

	t.Run("cpu_policy_exists", func(t *testing.T) {
		_, ok := changes["aws_appautoscaling_policy.cpu_target_tracking[0]"]
		assert.True(t, ok, "aws_appautoscaling_policy.cpu_target_tracking[0] must be in plan")
	})

	t.Run("policy_type_target_tracking", func(t *testing.T) {
		pol, ok := changes["aws_appautoscaling_policy.cpu_target_tracking[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, pol.Change.After)
		assert.Equal(t, "TargetTrackingScaling", after["policy_type"],
			"CPU policy type must be TargetTrackingScaling (WO-082 AC2)")
	})

	t.Run("target_value_60", func(t *testing.T) {
		pol, ok := changes["aws_appautoscaling_policy.cpu_target_tracking[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, pol.Change.After)
		configs := mustSlice(t, after["target_tracking_scaling_policy_configuration"])
		config := mustMap(t, configs[0])
		assert.Equal(t, float64(60), toFloat64AS(config["target_value"]),
			"CPU target_value must be 60 (WO-082 AC2)")
	})

	t.Run("scale_out_cooldown_60s", func(t *testing.T) {
		pol, ok := changes["aws_appautoscaling_policy.cpu_target_tracking[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, pol.Change.After)
		configs := mustSlice(t, after["target_tracking_scaling_policy_configuration"])
		config := mustMap(t, configs[0])
		assert.Equal(t, float64(60), toFloat64AS(config["scale_out_cooldown"]),
			"scale_out_cooldown must be 60 seconds (WO-082 AC2)")
	})

	t.Run("scale_in_cooldown_300s_longer_than_scale_out", func(t *testing.T) {
		pol, ok := changes["aws_appautoscaling_policy.cpu_target_tracking[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, pol.Change.After)
		configs := mustSlice(t, after["target_tracking_scaling_policy_configuration"])
		config := mustMap(t, configs[0])
		scaleIn := toFloat64AS(config["scale_in_cooldown"])
		scaleOut := toFloat64AS(config["scale_out_cooldown"])
		assert.Equal(t, float64(300), scaleIn,
			"scale_in_cooldown must be 300 seconds (WO-082 AC2)")
		assert.Greater(t, scaleIn, scaleOut,
			"scale_in_cooldown must be longer than scale_out_cooldown to prevent thrashing (WO-082 AC2)")
	})
}

// ── AC3: ALB step-scaling — 100% PercentChangeInCapacity, period=60, eval=2 ───

// TestEcsServiceAutoscaling_AlbStepScaling verifies the step-scaling policy and alarm.
func TestEcsServiceAutoscaling_AlbStepScaling(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../",
		Vars:         searchServiceAutoscalingVars(),
		PlanFilePath: "/tmp/ecs-autoscaling-alb-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct)
	changes := planStruct.ResourceChangesMap

	t.Run("step_policy_exists", func(t *testing.T) {
		_, ok := changes["aws_appautoscaling_policy.request_step_scaling[0]"]
		assert.True(t, ok, "aws_appautoscaling_policy.request_step_scaling[0] must be in plan")
	})

	t.Run("step_policy_type", func(t *testing.T) {
		pol, ok := changes["aws_appautoscaling_policy.request_step_scaling[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, pol.Change.After)
		assert.Equal(t, "StepScaling", after["policy_type"],
			"ALB scaling policy type must be StepScaling (WO-082 AC3)")
	})

	t.Run("step_adjustment_100_percent", func(t *testing.T) {
		pol, ok := changes["aws_appautoscaling_policy.request_step_scaling[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, pol.Change.After)
		configs := mustSlice(t, after["step_scaling_policy_configuration"])
		config := mustMap(t, configs[0])
		assert.Equal(t, "PercentChangeInCapacity", config["adjustment_type"],
			"ALB step scaling adjustment type must be PercentChangeInCapacity (WO-082 AC3)")
		steps := mustSlice(t, config["step_adjustment"])
		step := mustMap(t, steps[0])
		assert.Equal(t, float64(100), toFloat64AS(step["scaling_adjustment"]),
			"ALB step scaling_adjustment must be 100 percent (WO-082 AC3)")
		assert.Equal(t, float64(1), toFloat64AS(config["min_adjustment_magnitude"]),
			"MinAdjustmentMagnitude must be 1 (WO-082 AC3)")
	})

	t.Run("alb_alarm_period_60s", func(t *testing.T) {
		alm, ok := changes["aws_cloudwatch_metric_alarm.alb_request_count[0]"]
		require.True(t, ok, "aws_cloudwatch_metric_alarm.alb_request_count[0] must be in plan")
		after := mustDecodeAfterAS(t, alm.Change.After)
		assert.Equal(t, float64(60), toFloat64AS(after["period"]),
			"ALB alarm period must be 60 seconds (WO-082 AC3)")
	})

	t.Run("alb_alarm_eval_periods_2", func(t *testing.T) {
		alm, ok := changes["aws_cloudwatch_metric_alarm.alb_request_count[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, alm.Change.After)
		assert.Equal(t, float64(2), toFloat64AS(after["evaluation_periods"]),
			"ALB alarm evaluation_periods must be 2 (WO-082 AC3)")
	})

	t.Run("alb_alarm_metric_request_count_per_target", func(t *testing.T) {
		alm, ok := changes["aws_cloudwatch_metric_alarm.alb_request_count[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, alm.Change.After)
		assert.Equal(t, "RequestCountPerTarget", after["metric_name"],
			"ALB alarm must use RequestCountPerTarget metric (WO-082 AC3)")
		assert.Equal(t, "AWS/ApplicationELB", after["namespace"],
			"ALB alarm must be in AWS/ApplicationELB namespace (WO-082 AC3)")
	})
}

// ── AC4: Consumer — SQS queue depth, no CPU policy ───────────────────────────

// TestEcsServiceAutoscaling_Consumer_SqsOnly verifies notification-consumer
// scales on SQS ApproximateNumberOfMessagesVisible and has no CPU policy.
func TestEcsServiceAutoscaling_Consumer_SqsOnly(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../",
		Vars:         consumerAutoscalingVars(),
		PlanFilePath: "/tmp/ecs-autoscaling-consumer-tfplan",
		NoColor:      true,
	}

	planStruct := terraform.InitAndPlanAndShowWithStruct(t, opts)
	require.NotNil(t, planStruct)
	changes := planStruct.ResourceChangesMap

	t.Run("sqs_scale_out_alarm_metric", func(t *testing.T) {
		alm, ok := changes["aws_cloudwatch_metric_alarm.sqs_scale_out[0]"]
		require.True(t, ok, "sqs_scale_out alarm must be in plan for consumer")
		after := mustDecodeAfterAS(t, alm.Change.After)
		assert.Equal(t, "ApproximateNumberOfMessagesVisible", after["metric_name"],
			"Consumer scale-out alarm must use ApproximateNumberOfMessagesVisible (WO-082 AC4)")
		assert.Equal(t, "AWS/SQS", after["namespace"],
			"Consumer scale-out alarm must be in AWS/SQS namespace (WO-082 AC4)")
	})

	t.Run("sqs_scale_out_threshold_100", func(t *testing.T) {
		alm, ok := changes["aws_cloudwatch_metric_alarm.sqs_scale_out[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, alm.Change.After)
		assert.Equal(t, float64(100), toFloat64AS(after["threshold"]),
			"Consumer scale-out threshold must be 100 messages (WO-082 AC4)")
	})

	t.Run("sqs_scale_in_threshold_20", func(t *testing.T) {
		alm, ok := changes["aws_cloudwatch_metric_alarm.sqs_scale_in[0]"]
		require.True(t, ok)
		after := mustDecodeAfterAS(t, alm.Change.After)
		assert.Equal(t, float64(20), toFloat64AS(after["threshold"]),
			"Consumer scale-in threshold must be 20 messages (WO-082 AC4)")
	})

	t.Run("no_cpu_policy_for_consumer", func(t *testing.T) {
		_, hasCpu := changes["aws_appautoscaling_policy.cpu_target_tracking[0]"]
		assert.False(t, hasCpu,
			"notification-consumer must NOT have a CPU target-tracking policy (WO-082 AC4)")
	})

	t.Run("no_alb_policy_for_consumer", func(t *testing.T) {
		_, hasAlb := changes["aws_appautoscaling_policy.request_step_scaling[0]"]
		assert.False(t, hasAlb,
			"notification-consumer must NOT have an ALB step-scaling policy (WO-082 AC4)")
	})

	t.Run("consumer_sqs_step_policy_100_percent", func(t *testing.T) {
		pol, ok := changes["aws_appautoscaling_policy.sqs_step_out[0]"]
		require.True(t, ok, "sqs_step_out policy must be in plan for consumer")
		after := mustDecodeAfterAS(t, pol.Change.After)
		configs := mustSlice(t, after["step_scaling_policy_configuration"])
		config := mustMap(t, configs[0])
		assert.Equal(t, "PercentChangeInCapacity", config["adjustment_type"])
		steps := mustSlice(t, config["step_adjustment"])
		step := mustMap(t, steps[0])
		assert.Equal(t, float64(100), toFloat64AS(step["scaling_adjustment"]),
			"Consumer SQS step policy must add 100% capacity")
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func copyVars(src map[string]interface{}) map[string]interface{} {
	dst := make(map[string]interface{}, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func mustDecodeAfterAS(t *testing.T, raw interface{}) map[string]interface{} {
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

func toFloat64AS(v interface{}) float64 {
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

func mustSlice(t *testing.T, v interface{}) []interface{} {
	t.Helper()
	s, ok := v.([]interface{})
	require.True(t, ok, "expected slice, got %T", v)
	require.NotEmpty(t, s)
	return s
}

func mustMap(t *testing.T, v interface{}) map[string]interface{} {
	t.Helper()
	m, ok := v.(map[string]interface{})
	require.True(t, ok, "expected map, got %T", v)
	return m
}
