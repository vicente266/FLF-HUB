import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserCheck, EmailAlertChannel, RetryStrategyBuilder } from 'checkly/constructs';

// Who gets an email when it fails: the CHECKLY_ALERT_EMAIL repo variable (none: Health only).
const email = process.env.CHECKLY_ALERT_EMAIL;
const alertChannels = email ? [new EmailAlertChannel('hub-alerts', { address: email })] : [];

new BrowserCheck('hub-opens', {
	name: 'Hub opens in a browser',
	alertChannels,
	// One retry, so a single network blip isn't reported as the Hub being down.
	retryStrategy: RetryStrategyBuilder.singleRetry(),
	code: {
		entrypoint: path.join(path.dirname(fileURLToPath(import.meta.url)), 'hub.spec.js')
	}
});
