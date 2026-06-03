<!-- BEGIN:nextjs-agent-rules -->
USE bun.js For everything
BUILD_COMMAND: cd blu3-server && bun run build
TYPE_CHECK: cd blu3-server && npx tsc --noEmit
<!-- END:nextjs-agent-rules -->
