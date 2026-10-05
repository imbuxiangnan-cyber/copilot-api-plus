# 安全报告

发现可能泄露凭据、绕过访问控制、读取非预期数据或执行非预期操作的问题时，请通过仓库的 [GitHub 私密漏洞报告](https://github.com/imbuxiangnan-cyber/copilot-api-plus/security/advisories/new) 提交，不要在公开 Issue、PR 或评论中披露漏洞细节。

Please report suspected vulnerabilities through the private reporting link above, not a public issue.

## 报告内容

- 受影响的版本或 commit，以及运行环境。
- 最小复现步骤、预期行为和实际行为。
- 触发条件、影响范围，以及经过脱敏的日志或请求样例。
- 已尝试的缓解措施或修复建议（如有）。

使用测试数据和占位凭据。不要附带真实 Token、API Key、完整账号文件、代理密码或他人的请求内容；验证仅限你拥有或获准测试的环境。如果私密报告入口不可用，可通过普通 Issue 仅请求启用该入口，不要附加漏洞细节或利用代码。

## 版本与处理范围

请提供准确版本；条件允许时，确认问题是否也存在于当前 `main` 或最新发布版。修复范围按具体问题评估，不保证为所有旧版本提供回补，也不承诺固定响应或修复时限。适合公开的信息及披露时间可在私密报告中协商。

普通使用故障、模型可用性或上游限额问题，请参考 [SUPPORT.md](SUPPORT.md)。本项目是非官方兼容代理，GitHub/Copilot 服务本身的问题应通过其官方支持渠道处理。

若凭据已经公开，请先撤销或轮换相关凭据，再清理公开内容；仅删除日志或评论不能让已泄露的凭据失效。
