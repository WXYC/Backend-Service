#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const src = 'apps/backend/dist';
const dest = 'dist';

console.log('Copying backend dist to root dist/...');

if (!fs.existsSync(src)) {
  console.error(`Source directory ${src} does not exist`);
  process.exit(1);
}

// Remove existing dist directory if it exists
if (fs.existsSync(dest)) {
  console.log('Removing existing dist directory...');
  fs.rmSync(dest, { recursive: true, force: true });
}

// Copy the backend dist to root dist
try {
  fs.cpSync(src, dest, { recursive: true });
  console.log('✅ Successfully copied backend dist to root dist/');
} catch (error) {
  console.error('❌ Failed to copy dist directory:', error.message);
  process.exit(1);
}
