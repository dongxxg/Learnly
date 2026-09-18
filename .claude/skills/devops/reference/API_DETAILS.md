# DevOps API 详情

> 从 SKILL.md 提取的 API 端点参考。主文件链接至此。

### Query Pipeline List API

**Endpoint Information:**
- **URL**: http://192.168.118.247:2011/api/devops/pipeline/list/query
- **Method**: POST
- **Protocol**: HTTP (insecure mode, ignores SSL certificate validation)
- **Content-Type**: application/json; charset=UTF-8

**Request Headers:**
```
Accept: application/json, text/plain, */*
Accept-Language: zh-CN,zh;q=0.9
Authorization: bearer {token}
Content-Type: application/json; charset=UTF-8
```

### Request Body Structure
```json
{
  "creator": "",
  "groupId": "",
  "moduleId": "",
  "page": {
    "pageNum": 1,
    "pageSize": 10
  },
  "pipelineName": "",
  "productId": "",
  "projectId": "",
  "pipelineType": "",
  "favorite": true
}
```

### Response Handling

**Success Response** (code = "0000"):
- Extract `data.records` array containing pipeline information
- Extract pagination info: `pageNum`, `pageSize`, `pages`, `total`

**Error Response** (code ≠ "0000"):
- Priority 1: Use `tip` field if non-empty
- Priority 2: Use `msg` field if `tip` is empty

### Execute Pipeline API

**Endpoint Information:**
- **URL**: http://192.168.118.247:2011/api/devops/pipeline/excute
- **Method**: POST
- **Protocol**: HTTP (insecure mode, ignores SSL certificate validation)
- **Content-Type**: application/json; charset=UTF-8

**Request Headers:**
```
Accept: application/json, text/plain, */*
Authorization: bearer {token}
Content-Type: application/json; charset=UTF-8
```

**Request Body Structure:**
```json
{
  "id": "pipeline_id_here"
}
```

**Response Handling:**

**Success Response** (code = "0000"):
- Pipeline execution triggered successfully
- Extract success message from `tip` or `msg` field

**Error Response** (code ≠ "0000"):
- Priority 1: Use `tip` field if non-empty
- Priority 2: Use `msg` field if `tip` is empty

### Get Build Logs API

**Endpoint Information:**
- **URL**: http://192.168.118.247:2011/api/devops/pipeline/log/logstages_describe_list/query
- **Method**: GET
- **Protocol**: HTTP (insecure mode, ignores SSL certificate validation)

**Request Headers:**
```
Accept: application/json, text/plain, */*
Authorization: bearer {token}
```

**Query Parameters:**
- `pipelineId`: Pipeline ID

**Response Handling:**

**Success Response** (code = "0000"):
- Extract `data` array containing build information
- First item in array is the latest build
- Get `id` field from first item as the latest build number
- Build log URL format: `http://192.168.118.247:2011/pipeline/log/console_text/{pipelineId}/{buildNumber}`

**Error Response** (code ≠ "0000"):
- Priority 1: Use `tip` field if non-empty
- Priority 2: Use `msg` field if `tip` is empty

### Stop Pipeline API

**Endpoint Information:**
- **URL**: http://192.168.118.247:2011/api/devops/pipeline/stop
- **Method**: POST
- **Protocol**: HTTP (insecure mode, ignores SSL certificate validation)
- **Content-Type**: application/json; charset=UTF-8

**Request Headers:**
```
Accept: application/json, text/plain, */*
Authorization: bearer {token}
Content-Type: application/json; charset=UTF-8
```

**Request Body Structure:**
```json
{
  "buildNumber": "build_number_here",
  "pipelineId": "pipeline_id_here"
}
```

**Response Handling:**

**Success Response** (code = "0000"):
- Pipeline stopped successfully
- Extract success message from `tip` or `msg` field

**Error Response** (code ≠ "0000"):
- Priority 1: Use `tip` field if non-empty
- Priority 2: Use `msg` field if `tip` is empty

### Get Package List API

**Endpoint Information:**
- **URL**: http://192.168.118.247:2011/api/devops/pipeline/package/list/query
- **Method**: POST
- **Protocol**: HTTP (insecure mode, ignores SSL certificate validation)
- **Content-Type**: application/json; charset=UTF-8

**Request Headers:**
```
Accept: application/json, text/plain, */*
Authorization: bearer {token}
Content-Type: application/json; charset=UTF-8
```

**Request Body Structure:**
```json
{
  "packageName": "",
  "moduleId": "",
  "page": {
    "pageNum": 1,
    "pageSize": 10
  },
  "packageStatus": "",
  "productId": "",
  "projectId": "",
  "pipelineId": "",
  "packageVersion": "",
  "pipelineType": ""
}
```

**Response Handling:**

**Success Response** (code = "0000"):
- Extract `data.records` array containing package information
- Extract pagination info: `pageNum`, `pageSize`, `pages`, `total`
- `isBuildImage` = "Y" indicates the package has an associated image

**Error Response** (code ≠ "0000"):
- Priority 1: Use `tip` field if non-empty
- Priority 2: Use `msg` field if `tip` is empty
