# sites-cli

ChatGPT Sites へコマンド1つでデプロイするための CLI（開発前・調査フェーズ）。

- 経路: Codex を介さず `https://chatgpt.com/backend-api/ps/mcp` へ直接 MCP 接続する（経路A）
- 目標: Cloudflare の `cf` CLI と同じ使用感で、通常の Sites プロジェクトも、wrangler 前提の Cloudflare プロジェクトも `sites deploy` で上げられるようにする

調査資料は `docs/research/` にある。実装案は今後 `docs/` にまとめる。
