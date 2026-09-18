# DevOps Usage Examples

> 从 SKILL.md 提取的完整使用示例参考。主文件链接至此。

### Query Examples

#### Example 1: Query favorite pipelines (default)
```bash
python3 scripts/query_pipelines.py YOUR_TOKEN
```

#### Example 2: Query with custom page size
```bash
python3 scripts/query_pipelines.py YOUR_TOKEN --page-size 20
```

#### Example 3: Filter by pipeline name
```bash
python3 scripts/query_pipelines.py YOUR_TOKEN --pipeline-name devops --favorite false
```

#### Example 4: Query specific page with filters
```bash
python3 scripts/query_pipelines.py YOUR_TOKEN --page-num 2 --creator wangzk --group-id BPCE
```

### Execute Examples

#### Example 1: Execute a pipeline by ID
```bash
python3 scripts/execute_pipeline.py YOUR_TOKEN 23122716h8wxlgx09bx8
```

#### Example 2: Execute pipeline from query result
```bash
# First query to get pipeline ID
python3 scripts/query_pipelines.py YOUR_TOKEN --pipeline-name devops-service

# Then execute the pipeline using the ID from the query result
python3 scripts/execute_pipeline.py YOUR_TOKEN 201225153iz50i8uyxho
```

### Build Logs Examples

#### Example 1: Get build logs for a pipeline
```bash
python3 scripts/get_build_logs.py YOUR_TOKEN 202009216556356608
```

#### Example 2: Get logs and view in browser
```bash
# Get build information
python3 scripts/get_build_logs.py YOUR_TOKEN 202009216556356608

# The script will output the log URL, e.g.:
# http://192.168.118.247:2011/pipeline/log/console_text/202009216556356608/332
```

### Stop Pipeline Examples

#### Example 1: Stop a running pipeline
```bash
# First get the build number
python3 scripts/get_build_logs.py YOUR_TOKEN 202009216556356608

# Then stop the pipeline using the build number
python3 scripts/stop_pipeline.py YOUR_TOKEN 202009216556356608 332
```

#### Example 2: Complete workflow - execute, monitor, and stop
```bash
# 1. Execute pipeline
python3 scripts/execute_pipeline.py YOUR_TOKEN 202009216556356608

# 2. Check build status
python3 scripts/get_build_logs.py YOUR_TOKEN 202009216556356608

# 3. Stop if needed
python3 scripts/stop_pipeline.py YOUR_TOKEN 202009216556356608 333
```

### Package Query Examples

#### Example 1: Query packages for a specific pipeline
```bash
python3 scripts/get_packages.py YOUR_TOKEN --pipeline-id 202009216556356608
```

#### Example 2: Query packages with pagination
```bash
python3 scripts/get_packages.py YOUR_TOKEN --page-size 20 --page-num 1
```

#### Example 3: Query packages by name
```bash
python3 scripts/get_packages.py YOUR_TOKEN --package-name "unios-view"
```

#### Example 4: Complete workflow - query pipeline and its packages
```bash
# 1. Query pipelines
python3 scripts/query_pipelines.py YOUR_TOKEN --pipeline-name devops-view

# 2. Get packages for the pipeline
python3 scripts/get_packages.py YOUR_TOKEN --pipeline-id 202009216556356608
```
