const express = require('express');
const { handleLogin } = require('./routes');

const app = express();
app.post('/login', (req, res) => res.sendStatus(handleLogin(req.body)));

module.exports = app;
