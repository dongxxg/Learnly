'use strict';

const http = require('node:http');
const https = require('node:https');

function request(url, options, body) {
  const { timeoutMs, ...reqOptions } = options || {};
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs ?? 30000, () => { req.destroy(new Error('timeout')); });
    if (body != null) req.write(body);
    req.end();
  });
}

async function getJson(url, token) {
  const headers = {};
  if (token) headers['PRIVATE-TOKEN'] = token;
  const res = await request(url, { method: 'GET', headers });
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status} from ${url}: ${res.body.slice(0, 200)}`);
  }
  return JSON.parse(res.body);
}

async function getRaw(url, token) {
  const headers = {};
  if (token) headers['PRIVATE-TOKEN'] = token;
  const res = await request(url, { method: 'GET', headers });
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status} from ${url}: ${res.body.slice(0, 200)}`);
  }
  return res.body;
}

module.exports = { request, getJson, getRaw };
