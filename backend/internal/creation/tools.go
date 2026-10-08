package creation

import (
	"encoding/json"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

func isToolInput(input map[string]any) bool {
	config, _ := input["config"].(map[string]any)
	return input["localComfy"] != nil || strings.HasPrefix(stringValue(config["interfaceType"]), "runninghub-workflow-")
}

// Tools are media executors, never the text model that prepares a proposal.
func validateToolRequest(req *TaskRequest) (bool, error) {
	config, _ := req.Input["config"].(map[string]any)
	local := req.Input["localComfy"] != nil || strings.HasPrefix(req.Model, "local-comfy:") || req.Provider == "local-comfy"
	workflow := strings.HasPrefix(req.Model, "runninghub:") || strings.HasPrefix(stringValue(config["interfaceType"]), "runninghub-workflow-")
	if !local && !workflow {
		return false, nil
	}
	if local && workflow || (req.Type != "canvas_image" && req.Type != "canvas_video") || req.LogicalModelID != "" {
		return false, kernel.BadAuthRequest("制作工具仅支持独立的图片或视频任务")
	}
	mode := strings.TrimPrefix(req.Type, "canvas_")
	if local {
		selection, _ := req.Input["localComfy"].(map[string]any)
		id := stringValue(selection["recipeId"])
		if id == "" || req.Model != "local-comfy:"+id || req.Provider != "local-comfy" || stringValue(selection["recipeVersion"]) == "" || len(config) != 0 {
			return false, kernel.BadAuthRequest("Comfy 制作任务必须使用已选配方、版本和本地工具身份")
		}
		return true, nil
	}
	parts := strings.SplitN(req.Model, ":", 3)
	if len(parts) != 3 || parts[0] != "runninghub" || req.Provider != "runninghub" || (parts[1] != "app" && parts[1] != "workflow") {
		return false, kernel.BadAuthRequest("RunningHub 工具标识无效")
	}
	id, err := url.PathUnescape(parts[2])
	key := "webappId"
	if parts[1] == "workflow" {
		key = "workflowId"
	}
	if err != nil || id == "" || id != stringValue(config[key]) || stringValue(config["interfaceType"]) != "runninghub-workflow-"+mode || (parts[1] == "workflow" && stringValue(config["webappId"]) != "") {
		return false, kernel.BadAuthRequest("RunningHub 工具与实际工作流或生成模式不一致")
	}
	for _, key := range []string{"channelId", "credentialRef"} {
		if stringValue(config[key]) != "" {
			return false, kernel.BadAuthRequest("制作工具不能覆盖受管渠道凭据")
		}
	}
	return true, nil
}

// Only these transport fields can carry credentials into the protected task
// snapshot. The remaining request still obeys the ordinary record policy.
func validateTaskRecord(req TaskRequest, tool bool) error {
	if !tool {
		return ValidateJSON(req)
	}
	raw, err := json.Marshal(req)
	if err != nil || len(raw) > maxJSONBytes {
		return kernel.BadAuthRequest(msgJSONLimit)
	}
	var safe TaskRequest
	if err = json.Unmarshal(raw, &safe); err != nil {
		return err
	}
	config, _ := safe.Input["config"].(map[string]any)
	if raw := stringValue(config["baseUrl"]); raw != "" {
		endpoint, err := url.Parse(raw)
		if err != nil || endpoint.Host == "" || (endpoint.Scheme != "https" && endpoint.Scheme != "http") || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
			return kernel.BadAuthRequest("工作流地址不能携带凭据、查询参数或片段")
		}
	}
	for _, key := range []string{"baseUrl", "apiKey", "runningHubWalletApiKey", "runningHubUploadApiKey"} {
		if value, ok := config[key]; ok && value != nil {
			if _, ok := value.(string); !ok {
				return kernel.BadAuthRequest("工作流连接字段必须为文本")
			}
		}
		delete(config, key)
	}
	if headers, ok := config["headers"].([]any); ok && len(headers) == 0 {
		delete(config, "headers")
	}
	return ValidateJSON(safe)
}

func recipeOptions(input map[string]any) map[string]any {
	selection, _ := input["localComfy"].(map[string]any)
	spec, _ := selection["recipeSpec"].(map[string]any)
	output, _ := spec["output"].(map[string]any)
	if len(output) == 0 {
		return nil
	}
	options := map[string]any{
		"recipeId": selection["recipeId"], "recipeVersion": selection["recipeVersion"], "recipeOutput": output,
		"size": stringValue(output["width"]) + "x" + stringValue(output["height"]),
	}
	if duration, ok := output["duration_seconds"]; ok {
		options["videoSeconds"] = duration
	}
	return options
}

func freezePreparedRecipe(req *TaskRequest, prepared *PreparedTask) error {
	if req.Input["localComfy"] == nil {
		return nil
	}
	selection, _ := prepared.Input["localComfy"].(map[string]any)
	spec, _ := selection["recipeSpec"].(map[string]any)
	want, _ := req.Input["localComfy"].(map[string]any)
	mode := map[string]string{"t2i": "image", "i2i": "image", "t2v": "video", "i2v": "video"}[stringValue(spec["mode"])]
	if stringValue(selection["recipeId"]) != stringValue(want["recipeId"]) || stringValue(selection["recipeVersion"]) != stringValue(want["recipeVersion"]) || stringValue(spec["id"]) != stringValue(selection["recipeId"]) || stringValue(spec["recipe_version"]) != stringValue(selection["recipeVersion"]) || mode == "" || mode != stringValue(req.Input["mode"]) || recipeOptions(prepared.Input) == nil {
		return Conflict("Comfy 配方版本或输出规格已变化，请重新准备并确认")
	}
	frozen, err := cloneJSON(selection)
	if err != nil {
		return err
	}
	if err = ValidateJSON(frozen); err != nil {
		return err
	}
	req.Input["localComfy"] = frozen
	return nil
}
