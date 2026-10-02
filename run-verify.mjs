// jiti 运行器：注入 ~/ 别名后执行冒烟脚本
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
  alias: {
    '~': '/workspace',
    '@': '/workspace'
  }
});

await jiti.import('./scripts/verify-snapshot.ts');
