"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
//import { thingy } from './thing.js';
//import fetch, { Response as Fetch_Response } from 'node-fetch';
const express_1 = __importDefault(require("express"));
//const res: Fetch_Response = await fetch('https://cat-fact.herokuapp.com/facts');
// if (res.ok) {
//   const data = await res.json();
//   console.log(data);
// }
//thingy();
const app = (0, express_1.default)();
const port = 3000;
app.get('/', (req, res) => {
    res.send('hello world');
});
app.listen(port, () => {
    console.log('listening on a port!');
});
