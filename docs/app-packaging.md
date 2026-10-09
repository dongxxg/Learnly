# 知芽 app 端云打包操作手册

> 对应变更 `literacy-module` 任务 16.2。AI 侧已完成 manifest 配置与备料；
> 标注 **【用户操作】** 的步骤需要账号/证书，AI 无法代办。

## 前置状态（已完成）

- `manifest.json` app-plus 段已配置：应用名称"知芽"、splashscreen、Android INTERNET/网络状态权限
- 书写组件走 renderjs（视图层），**无需勾选任何原生 module**
- 笔顺数据（1.1MB）与读音音频（2.5MB）已内嵌 `src/`，随包打包，无运行时下载

## 步骤

### 1.【用户操作】注册 DCloud 开发者并获取 appid

1. 注册/登录 <https://dev.dcloud.org.cn>
2. HBuilderX → 打开本项目 `frontend` 目录 → 右键 `manifest.json` → **重新获取appid**
   （或在 DCloud 开发者中心创建应用后把 appid 填入 `manifest.json` 的 `appid` 字段）

### 2.【用户操作】生成安卓签名证书（keystore）

方式 A —— HBuilderX 生成（推荐，最简单）：
- HBuilderX 菜单 → 工具 → **生成安卓签名证书**（需 DCloud 账号登录）
- 记录：证书文件路径、证书密码、别名、别名密码

方式 B —— 命令行 keytool：
```bash
keytool -genkey -alias learnly -keyalg RSA -keysize 2048 \
  -validity 36500 -keystore learnly.keystore
```

> 证书是应用更新链路的身份凭证，**丢失后无法以同一签名更新应用**，务必备份。

### 3. 本地出包验证（可选但建议）

```bash
npm run build:app
```
产物为 HBuilderX 可识别的本地资源；或直接用 HBuilderX：
运行 → 运行到手机或模拟器 → **制作自定义调试基座**（云打包一次，用于真机调试）。

### 4. 云打包正式包

HBuilderX → 发行 → **原生App-云打包**：

| 项 | 建议值 |
|---|---|
| Android 包名 | `cn.zhiya.learnly`（或自有域名反写） |
| 证书 | 使用自有证书（上一步生成） |
| 渠道/打包类型 | 正式包（发布用）；调试基座仅自测 |
| iOS | 无 Apple 开发者账号前先跳过 |

### 5.【用户操作】验收冒烟（对应任务 16.3）

安装到真机后按闭环验证：

1. 注册/登录 → 创建儿童档案 → 切换
2. 首页"知芽识字" → 列表按简单→复杂展示、分页/筛选
3. 详情页 → 听读音、看笔顺动画
4. "写一写" → 手指按笔顺书写 → 乱序被拒、连错 2 次出提示 → 全对自动变"已学"
5. 返回列表 → 该字角标已刷新

## 已知边界

- iOS 打包需 Apple 开发者账号与证书（.p12 + 描述文件），由用户自行提供后再走云打包
- 首次出包建议先用"自定义调试基座"验证书写交互（webview 内 touch 时序与 H5 有差异），
  再出正式包
