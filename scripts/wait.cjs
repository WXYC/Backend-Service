#!/usr/bin/env node

const seconds = parseInt(process.argv[2]) || 5;
console.log(`Waiting ${seconds} seconds...`);
setTimeout(() => {
  console.log('Wait complete!');
}, seconds * 1000);
