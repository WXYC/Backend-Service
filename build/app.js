import { thingy } from './thing.js';
import fetch from 'node-fetch';
import express from 'express';
const res = await fetch('https://cat-fact.herokuapp.com/facts');
if (res.ok) {
    const data = await res.json();
    console.log(data);
}
thingy();
const app = express();
const port = 3000;
app.get('/', (req, res) => {
    res.send('hello world');
});
app.listen(port, () => {
    console.log('listening on a port!');
});
