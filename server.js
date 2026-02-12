const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Hello from Express!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Export the app for Vercel
module.exports = app;