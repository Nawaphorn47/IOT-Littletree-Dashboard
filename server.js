const express = require('express');
const cors = require('cors');
const { InfluxDB } = require('@influxdata/influxdb-client');
const mqtt = require('mqtt'); // 🌟 นำเข้า MQTT

const app = express();
const port = 3000;

app.use(express.static('public'))
app.use(cors()); 
app.use(express.json()); // 🌟 ให้ Express อ่าน JSON จากหน้าเว็บได้

// ---------------- ตั้งค่า InfluxDB ----------------
const url = 'https://us-east-1-1.aws.cloud2.influxdata.com';
const token = 'x5MZQdYA2jGPv4Qmuyc18m_t3mjzNl8wDiz6ahuKOjOiNIRieHLClWYlL5CfNWzhQUBJLY_ux0K91Rt5498o_g==';
const org = 'littletree';
const bucket = 'farm_data';

const client = new InfluxDB({ url, token });
const queryApi = client.getQueryApi(org);

// ---------------- ตั้งค่า MQTT ----------------
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com');
const mqttTopic = 'SmartFarm/Pump2/Control';

mqttClient.on('connect', () => {
    console.log('✅ เชื่อมต่อ MQTT สำเร็จ');
});

// ---------------- 1. API ดึงค่าปัจจุบัน (เพิ่ม Limit ป้องกันข้อมูลซ้ำ) ----------------
app.get('/api/sensors', async (req, res) => {
    const fluxQuery = `
        from(bucket: "${bucket}")
        |> range(start: -1h)
        |> filter(fn: (r) => r["_measurement"] == "rain_sensor" or r["_measurement"] == "soil_sensor" or r["_measurement"] == "ec_sensor")
        |> filter(fn: (r) => r["_field"] == "value")
        |> last()
    `;

    try {
        const results = [];
        for await (const {values, tableMeta} of queryApi.iterateRows(fluxQuery)) {
            const o = tableMeta.toObject(values);
            results.push({ sensor: o._measurement, value: o._value });
        }
        res.json(results);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ' });
    }
});

// ---------------- 2. API ดึงข้อมูลย้อนหลัง 24 ชั่วโมง ----------------
app.get('/api/history', async (req, res) => {
    // ดึงย้อนหลัง 24h และหาค่าเฉลี่ยทุกๆ 15 นาที
    const fluxQueryHistory = `
        from(bucket: "${bucket}")
        |> range(start: -24h)
        |> filter(fn: (r) => r["_measurement"] == "rain_sensor" or r["_measurement"] == "soil_sensor" or r["_measurement"] == "ec_sensor")
        |> filter(fn: (r) => r["_field"] == "value")
        |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
    `;

    try {
        const results = { rain: [], soil: [], ec: [] };
        for await (const {values, tableMeta} of queryApi.iterateRows(fluxQueryHistory)) {
            const o = tableMeta.toObject(values);
            if (o._measurement === 'rain_sensor') results.rain.push({ x: o._time, y: o._value });
            if (o._measurement === 'soil_sensor') results.soil.push({ x: o._time, y: o._value });
            if (o._measurement === 'ec_sensor') results.ec.push({ x: o._time, y: o._value });
        }
        res.json(results);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'ดึงข้อมูลประวัติไม่สำเร็จ' });
    }
});

// ---------------- 3. API สั่งเปิด-ปิดปั๊มน้ำ (MQTT) ----------------
app.post('/api/pump', (req, res) => {
    const { command } = req.body; // รับค่า ON, OFF, หรือ AUTO จากหน้าเว็บ
    if (['ON', 'OFF', 'AUTO'].includes(command)) {
        mqttClient.publish(mqttTopic, command);
        res.json({ success: true, message: `ส่งคำสั่ง ${command} สำเร็จ` });
    } else {
        res.status(400).json({ success: false, message: 'คำสั่งไม่ถูกต้อง' });
    }
});

app.listen(port, () => {
    console.log(`🚀 Server กำลังรันอยู่ที่ http://localhost:${port}`);
});