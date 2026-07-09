const express = require('express');
const fs = require('fs/promises');
const mqtt = require('mqtt');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const SCHEDULE_UPDATED_TOPIC = process.env.SCHEDULE_UPDATED_TOPIC || 'motrex/schedule/updated';
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');

const app = express();
let mqttClient = null;
let mqttConnected = false;

app.use(express.json());

function getMqttErrorMessage(error) {
  return error?.message || error?.code || 'MQTT broker is unavailable';
}

async function readSchedules() {
  const rawSchedules = await fs.readFile(SCHEDULES_PATH, 'utf8');
  return JSON.parse(rawSchedules);
}

function getMqttClient() {
  if (mqttClient) {
    return mqttClient;
  }

  mqttClient = mqtt.connect(MQTT_URL, {
    reconnectPeriod: 3000
  });

  mqttClient.on('error', (error) => {
    console.error(`MQTT error: ${getMqttErrorMessage(error)}`);
  });

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log(`MQTT connected: ${MQTT_URL}`);
  });

  mqttClient.on('offline', () => {
    mqttConnected = false;
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
  });

  return mqttClient;
}

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/api/schedules', async (_request, response) => {
  try {
    response.json(await readSchedules());
  } catch (error) {
    response.status(500).json({
      error: 'Failed to read schedules',
      message: error.message
    });
  }
});

app.post('/api/schedules/notify-update', (request, response) => {
  const client = getMqttClient();

  if (!mqttConnected) {
    response.status(503).json({
      error: 'MQTT broker is not connected',
      mqttUrl: MQTT_URL
    });
    return;
  }

  const payload = JSON.stringify({
    type: 'schedule_updated',
    updatedAt: new Date().toISOString(),
    ...request.body
  });

  client.publish(SCHEDULE_UPDATED_TOPIC, payload, { qos: 1 }, (error) => {
    if (error) {
      response.status(500).json({
        error: 'Failed to publish MQTT message',
        message: getMqttErrorMessage(error)
      });
      return;
    }

    response.json({
      ok: true,
      topic: SCHEDULE_UPDATED_TOPIC,
      payload: JSON.parse(payload)
    });
  });
});

app.listen(PORT, () => {
  console.log(`Schedule API server listening on http://localhost:${PORT}`);
  console.log(`MQTT update topic: ${SCHEDULE_UPDATED_TOPIC}`);
});
