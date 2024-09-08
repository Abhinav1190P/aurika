const express = require('express');
const router = express.Router();
const { generateInvoice, validateInvoiceData } = require('./invoiceService');

router.post('/generate-invoice', async (req, res) => {
    try {
        const invoiceData = req.body;


        const validationResult = validateInvoiceData(invoiceData);
        if (!validationResult.valid) {

            return res.status(400).send({ error: validationResult.message });
        }
        const { pdfBuffer, savedFilePath } = await generateInvoice(invoiceData);


        res.type('application/pdf');
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error generating invoice:', error);
        res.status(500).send({ error: 'Failed to generate invoice' });
    }
});

router.post('/enqueue-invoice', async (req, res) => {
    try {
        const invoiceData = req.body;
        const validationResult = validateInvoiceData(invoiceData);
        if (!validationResult.valid) {
            return res.status(400).send({ error: validationResult.message });
        }

        await addInvoiceToQueue(invoiceData);

        res.status(202).send({ message: 'Invoice generation job added to the queue' });
    } catch (error) {
        console.error('Error adding invoice job to the queue:', error);
        res.status(500).send({ error: 'Failed to add invoice job to the queue' });
    }
});

module.exports = router;
