#!/usr/bin/env node
/**
 * NSMT Scorebug — Create Event Script
 *
 * Usage:
 *   node create-event.js <eventId> <operatorPin> <ownerPin> [eventTitle]
 *
 * Example:
 *   node create-event.js chipotle-qf1 1234 987654 "CHIPOTLE NATIONALS - QUARTERFINAL"
 *
 * Requirements:
 *   - operatorPin: minimum 4 digits
 *   - ownerPin: minimum 6 digits
 *   - operatorPin and ownerPin must be different
 */

const https = require('https');

const PROJECT_ID = 'sincere-nirvana-436014-v9';
const REGION = 'us-central1';
const FUNCTION_URL = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/createEvent`;

const args = process.argv.slice(2);

if (args.length < 3) {
  console.error('\nUsage: node create-event.js <eventId> <operatorPin> <ownerPin> [eventTitle]\n');
  console.error('Example: node create-event.js chipotle-qf1 1234 987654 "CHIPOTLE NATIONALS - QF"');
  process.exit(1);
}

const [eventId, operatorPin, ownerPin, eventTitle] = args;

if (operatorPin.length < 4) {
  console.error('Error: Operator PIN must be at least 4 digits.');
  process.exit(1);
}
if (ownerPin.length < 6) {
  console.error('Error: Owner PIN must be at least 6 digits.');
  process.exit(1);
}
if (operatorPin === ownerPin) {
  console.error('Error: Operator and owner PINs must be different.');
  process.exit(1);
}

// Firebase callable functions expect { data: {...} } wrapper
const payload = JSON.stringify({
  data: {
    eventId,
    operatorPin,
    ownerPin,
    eventTitle: eventTitle || eventId
  }
});

const url = new URL(FUNCTION_URL);

const options = {
  hostname: url.hostname,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

console.log(`\nCreating event "${eventId}"...`);

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    try {
      const response = JSON.parse(body);
      if (response.result && response.result.success) {
        console.log(`\nEvent created successfully!`);
        console.log(`\n  Event ID:      ${eventId}`);
        console.log(`  Operator PIN:  ${operatorPin}`);
        console.log(`  Owner PIN:     ${ownerPin}`);
        console.log(`  Title:         ${eventTitle || eventId}`);
        console.log(`\nOverlay URL:`);
        console.log(`  https://thensmt.github.io/scorebug/yolo-overlay.html?event=${eventId}`);
        console.log(`\nControl URL:`);
        console.log(`  https://thensmt.github.io/scorebug/yolo-control.html?event=${eventId}\n`);
      } else if (response.error) {
        console.error(`\nError: ${response.error.message || JSON.stringify(response.error)}\n`);
      } else {
        console.error(`\nUnexpected response: ${body}\n`);
      }
    } catch (e) {
      console.error(`\nFailed to parse response: ${body}\n`);
    }
  });
});

req.on('error', (e) => {
  console.error(`\nRequest failed: ${e.message}\n`);
});

req.write(payload);
req.end();
