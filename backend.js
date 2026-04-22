const express = require('express');
const app = express();

app.use(express.static('assets'));

app.get('/', (req, res) => {
    res.send('Backend funcionando correctamente');
});

app.listen(3000, () => {
    console.log('Servidor backend activo en puerto 3000');
});
