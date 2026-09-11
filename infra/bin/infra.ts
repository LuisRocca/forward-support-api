import { App } from 'aws-cdk-lib';

import { ForwardStack } from '../lib/forward-stack.js';

const app = new App();

new ForwardStack(app, 'ForwardStack', {
  env: { account: process.env['CDK_DEFAULT_ACCOUNT'], region: 'us-east-1' },
});
