// The name people see on windows and in the tray: `displayName` in
// package.json. `productName` ("IPFS Desktop") stays as it is because Electron
// derives the app name from it, and the app name decides the userData
// directory; renaming it would orphan the user's settings, repo pointer and
// stored tokens. Only text that a person reads uses this constant.
module.exports = require('../../package.json').displayName
