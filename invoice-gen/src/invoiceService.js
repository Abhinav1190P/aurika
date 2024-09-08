const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs').promises;
const Handlebars = require('handlebars');
const Joi = require('joi');
const crypto = require('crypto'); // For generating unique hash


const templateCache = new Map();

async function loadTemplate(templateName) {
    if (templateCache.has(templateName)) {
        return templateCache.get(templateName);
    }
    const filePath = path.join(__dirname, 'templates', `${templateName}.hbs`);
    const source = await fs.readFile(filePath, 'utf-8');
    const template = Handlebars.compile(source);
    templateCache.set(templateName, template);
    return template;
}

async function saveInvoicePDF(pdfBuffer, invoiceNumber) {
    const storagePath = path.join(__dirname, 'invoices');
    const fileName = `invoice_${invoiceNumber}.pdf`;
    const filePath = path.join(storagePath, fileName);

    try {
        await fs.mkdir(storagePath, { recursive: true });
        await fs.writeFile(filePath, pdfBuffer);
        console.log(`Invoice saved: ${filePath}`);
        return filePath;
    } catch (error) {
        console.error('Error saving invoice:', error);
        throw error;
    }
}






function numberToWords(num) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];

    function convertLessThanOneThousand(n) {
        if (n < 10) return ones[n];
        if (n < 20) return teens[n - 10];
        if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
        return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' ' + convertLessThanOneThousand(n % 100) : '');
    }

    if (num === 0) return 'Zero';

    const parts = [];
    if (num >= 10000000) {
        parts.push(convertLessThanOneThousand(Math.floor(num / 10000000)) + ' Crore');
        num %= 10000000;
    }
    if (num >= 100000) {
        parts.push(convertLessThanOneThousand(Math.floor(num / 100000)) + ' Lakh');
        num %= 100000;
    }
    if (num >= 1000) {
        parts.push(convertLessThanOneThousand(Math.floor(num / 1000)) + ' Thousand');
        num %= 1000;
    }
    if (num > 0) {
        parts.push(convertLessThanOneThousand(num));
    }

    return parts.join(' ');
}



async function generateInvoice(data) {
    try {

        const calculatedData = calculateInvoiceTotals(data.items, data.placeOfSupply, data.placeOfDelivery);
        const fullInvoiceData = { ...data, ...calculatedData };

        const amountInWords = numberToWords(Math.round(fullInvoiceData.grandTotal)) + ' Rupees Only';
        const templateData = { ...fullInvoiceData, amountInWords };

        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        const html = await loadTemplate('invoice', templateData);

        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
        });

        await browser.close();

        const savedFilePath = await saveInvoicePDF(pdfBuffer, data.invoiceDetails.invoiceNo);
        console.log('Invoice saved at:', savedFilePath);

        return { pdfBuffer, savedFilePath };
    } catch (error) {
        console.error('Error generating invoice:', error);
        throw error;
    }
}



function validateInvoiceData(data) {
    const schema = Joi.object({
        sellerDetails: Joi.object({
            name: Joi.string().required(),
            address: Joi.string().required(),
            city: Joi.string().required(),
            state: Joi.string().required(),
            pincode: Joi.string().pattern(/^\d{6}$/).required(),
            panNo: Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).required(),
            gstRegistrationNo: Joi.string().required()
        }).required(),

        placeOfSupply: Joi.string().required(),

        billingDetails: Joi.object({
            name: Joi.string().required(),
            address: Joi.string().required(),
            city: Joi.string().required(),
            state: Joi.string().required(),
            pincode: Joi.string().pattern(/^\d{6}$/).required(),
            stateCode: Joi.string().pattern(/^\d{1,2}$/).required()
        }).required(),

        shippingDetails: Joi.object({
            name: Joi.string().required(),
            address: Joi.string().required(),
            city: Joi.string().required(),
            state: Joi.string().required(),
            pincode: Joi.string().pattern(/^\d{6}$/).required(),
            stateCode: Joi.string().pattern(/^\d{1,2}$/).required()
        }).required(),

        placeOfDelivery: Joi.string().required(),

        orderDetails: Joi.object({
            orderNo: Joi.string().required(),
            orderDate: Joi.date().iso().required()
        }).required(),

        invoiceDetails: Joi.object({
            invoiceNo: Joi.string().required(),
            invoiceDetails: Joi.string().required(),
            invoiceDate: Joi.date().iso().required(),
            reverseCharge: Joi.string().valid('Yes', 'No').required()
        }).required(),

        items: Joi.array().items(
            Joi.object({
                description: Joi.string().required(),
                unitPrice: Joi.number().positive().required(),
                quantity: Joi.number().integer().positive().required(),
                discount: Joi.number().min(0).default(0),
                taxRate: Joi.number().valid(18).required()
            })
        ).min(1).required(),

        signatureImage: Joi.string().uri().required(),
        companyLogo: Joi.string().uri().required()
    });

    const { error } = schema.validate(data);
    if (error) {
        return { valid: false, message: `Invalid input data: ${error.details[0].message}` };
    }
    return { valid: true };
}


function calculateInvoiceTotals(items, placeOfSupply, placeOfDelivery) {
    let totalNetAmount = 0;
    let totalTaxAmount = 0;

    items.forEach(item => {
        const netAmount = item.unitPrice * item.quantity - (item.discount || 0);
        const taxAmount = netAmount * (item.taxRate / 100);

        totalNetAmount += netAmount;
        totalTaxAmount += taxAmount;

        item.netAmount = netAmount;
        item.taxAmount = taxAmount;
        item.totalAmount = netAmount + taxAmount;

        if (placeOfSupply === placeOfDelivery) {
            item.cgst = taxAmount / 2;
            item.sgst = taxAmount / 2;
        } else {
            item.igst = taxAmount;
        }
    });

    return {
        items,
        totalNetAmount,
        totalTaxAmount,
        grandTotal: totalNetAmount + totalTaxAmount
    };
}


module.exports = { generateInvoice, validateInvoiceData };
