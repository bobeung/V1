// Load required libraries
const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'mysecret';
const COMPANY_PHONE = process.env.COMPANY_PHONE || '+1-555-000-0000';

/ ==================== CORS SETUP ====================
app.use(cors({
  origin: ['https://www.militaryrides.org', 'https://militaryrides.org'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-webhook-token']
}));

// Handle preflight (OPTIONS) for ALL routes
app.options('*', cors());
// ===================================================

// In-memory storage (like a simple database for demo)
const rides = new Map(); // Stores ride requests: rideId -> { id, pickup, drop, riderPhone, status, driver }
const drivers = new Map(); // Stores drivers: driverId -> { id, name, phone, status }

// Middleware to parse incoming data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Helper: Generate random ID
function generateId() {
  return Math.random().toString(36).slice(2, 8); // Simple 6-character ID
}

// Helper: Check webhook secret
function checkSecret(req) {
  const token = req.headers['x-webhook-token'] || req.query.token || req.body.token;
  return token === WEBHOOK_SECRET;
}

// Helper: Parse ride request (e.g., "Gate 2 to Walmart")
function parseRide(text) {
  if (!text) return null;
  const parts = text.trim().split(/to|-|→/i); // Split by 'to', '-', or '→'
  if (parts.length < 1) return null;
  return {
    pickup: parts[0].trim(),
    drop: parts[1] ? parts[1].trim() : 'Not specified'
  };
}

// Twilio SMS
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function sendSms(to, message) {
  try {
    await client.messages.create({
      to,
      from: process.env.COMPANY_PHONE,
      body: message
    });
    console.log(`[SMS] To: ${to}, Message: ${message}`);
    return true;
  } catch (error) {
    console.error(`SMS failed: ${error.message}`);
    return false;
  }
}

// Placeholder: Broadcast ride to drivers
async function broadcastRide(ride) {
  const message = `New ride: ${ride.pickup} to ${ride.drop}. Reply "1" to claim.`;
  for (const driver of drivers.values()) {
    if (driver.status === 'ON') {
      await sendSms(driver.phone, message);
    }
  }
}

// Webhook: Handle incoming SMS ride requests
app.post('/webhook/sms', async (req, res) => {
  // Check secret
  if (!checkSecret(req)) {
    return res.status(401).send('Unauthorized');
  }

  // Send quick response to webhook provider
  res.status(200).send('OK');

  // Get phone and text from request
  const riderPhone = req.body.from || req.body.phone;
  const text = req.body.text || req.body.body;
  if (!riderPhone || !text) {
    console.log('Bad SMS data:', req.body);
    return;
  }

  // Parse ride request
  const rideDetails = parseRide(text);
  if (!rideDetails) {
    await sendSms(riderPhone, 'Please send like: Gate 2 to Walmart');
    return;
  }

  // Create new ride
  const rideId = generateId();
  const ride = {
    id: rideId,
    pickup: rideDetails.pickup,
    drop: rideDetails.drop,
    riderPhone,
    status: 'OPEN',
    driver: null
  };
  rides.set(rideId, ride);

  // Broadcast to drivers
  await broadcastRide(ride);

  // Notify rider
  await sendSms(riderPhone, 'Ride request received! Waiting for a driver.');
});

// Webhook: Handle driver responses
app.post('/webhook/driver', async (req, res) => {
  if (!checkSecret(req)) {
    return res.status(401).send('Unauthorized');
  }
  res.status(200).send('OK');

  const driverId = req.body.driver_id;
  const text = (req.body.text || '').trim();
  const driverPhone = req.body.from;

  if (!driverId || !text || text !== '1') {
    await sendSms(driverPhone, 'Reply with "1" to claim a ride.');
    return;
  }

  // Find first open ride (simplified for demo)
  const openRide = Array.from(rides.values()).find(r => r.status === 'OPEN');
  if (!openRide) {
    await sendSms(driverPhone, 'No open rides to claim.');
    return;
  }

  // Assign ride to driver
  openRide.status = 'ASSIGNED';
  openRide.driver = driverId;
  rides.set(openRide.id, openRide);

  // Notify driver
  const driver = drivers.get(driverId) || { name: 'Driver', phone: driverPhone };
  await sendSms(driver.phone, `Ride assigned! Pickup: ${openRide.pickup}, Drop: ${openRide.drop}, Rider: ${openRide.riderPhone}`);

  // Notify rider
  await sendSms(openRide.riderPhone, `Driver ${driver.name} assigned! They’ll contact you soon.`);
});

// Helper: Register a driver (for testing)
app.post('/driver/register', (req, res) => {
  const { driver_id, name, phone } = req.body;
  if (!driver_id || !phone) {
    return res.status(400).json({ error: 'Need driver_id and phone' });
  }
  drivers.set(driver_id, { id: driver_id, name: name || 'Driver', phone, status: 'ON' });
  res.json({ message: 'Driver registered', driver: drivers.get(driver_id) });
});

// Text Editor: Simple web form for testing
app.get('/', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>M.Rides Test Editor</h1>
        <h3>Send Ride Request (SMS)</h3>
        <form action="/webhook/sms" method="POST">
          <input type="hidden" name="token" value="${WEBHOOK_SECRET}">
          <label>Phone: <input type="text" name="from" value="+1234567890"></label><br>
          <label>Request: <input type="text" name="text" value="Gate 2 to Walmart"></label><br>
          <button type="submit">Send Ride</button>
        </form>
        <h3>Register Driver</h3>
        <form action="/driver/register" method="POST">
          <label>Driver ID: <input type="text" name="driver_id" value="drv_1"></label><br>
          <label>Name: <input type="text" name="name" value="Alice"></label><br>
          <label>Phone: <input type="text" name="phone" value="+1987654321"></label><br>
          <button type="submit">Register Driver</button>
        </form>
        <h3>Driver Reply</h3>
        <form action="/webhook/driver" method="POST">
          <input type="hidden" name="token" value="${WEBHOOK_SECRET}">
          <label>Driver ID: <input type="text" name="driver_id" value="drv_1"></label><br>
          <label>Phone: <input type="text" name="from" value="+1987654321"></label><br>
          <label>Reply: <input type="text" name="text" value="1"></label><br>
          <button type="submit">Send Reply</button>
        </form>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});