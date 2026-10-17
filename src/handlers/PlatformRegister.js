/**
 * PlatformRegister  (PlatformRegisterReq -> PlatformRegisterRes)
 * O cliente 1.27 (Free Fire 2019) chama /PlatformRegister (o 1.43 usa
 * /MajorRegister). Mesmo payload do MajorRegister: nickname + access_token.
 * reference: platform_register @ htpp.py:1903 -> mesma resposta do MajorRegister.
 */

'use strict';

const handleMajorRegister = require('./MajorRegister').handler;

async function handlePlatformRegister(reqObj, ctx) {
  return handleMajorRegister(reqObj, ctx);
}

module.exports = {
  endpoint: 'PlatformRegister',
  reqType: 'PlatformRegisterReq',
  resType: 'PlatformRegisterRes',
  handler: handlePlatformRegister
};
