const express = require('express');
const cors = require('cors');
const { InfluxDB } = require('@influxdata/influxdb-client');
const mqtt = require('mqtt'); // 🌟 นำเข้า MQTT

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public')); // 🌟 ให้ Express เสิร์ฟไฟล์จากโฟลเดอร์ public   
app.use(cors()); 
app.use(express.json()); // 🌟 ให้ Express อ่าน JSON จากหน้าเว็บได้

// ---------------- ตั้งค่า InfluxDB ----------------
const url = 'https://us-east-1-1.aws.cloud2.influxdata.com';
const token = 'x5MZQdYA2jGPv4Qmuyc18m_t3mjzNl8wDiz6ahuKOjOiNIRieHLClWYlL5CfNWzhQUBJLY_ux0K91Rt5498o_g==';
const org = 'littletree';
const bucket = 'farm_data';

const client = new InfluxDB({ url, token });
const queryApi = client.getQueryApi(org);

let realPumpStatus = 'OFF'; // ตัวแปรจำสถานะปั๊มจริง
let realAutoStatus = 'OFF'; // ตัวแปรจำสถานะออโต้จริง

// ---------------- ตั้งค่า MQTT ----------------
const mqttClient = mqtt.connect('ws://broker.hivemq.com:8000/mqtt');
const mqttTopic = 'SmartFarm/Pump2/Control';
const mqttTopicStatus = 'SmartFarm/Pump2/Status';

mqttClient.on('connect', () => {
    console.log('✅ เชื่อมต่อ MQTT สำเร็จ');
    mqttClient.subscribe(mqttTopicStatus);  
});

mqttClient.on('message', (topic, message) => {
    if (topic === mqttTopicStatus) {
        const msg = message.toString();
        if (msg.startsWith('PUMP:')) realPumpStatus = msg.split(':')[1];
        if (msg.startsWith('AUTO:')) realAutoStatus = msg.split(':')[1];
    }
});

// 🌟 สร้าง API ใหม่ให้หน้าเว็บเข้ามาแอบดูสถานะจริง
app.get('/api/pump/status', (req, res) => {
    res.json({ pump: realPumpStatus, auto: realAutoStatus });
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
// ---------------- 2. API ดึงข้อมูลย้อนหลัง 24 ชั่วโมง ----------------
app.get('/api/history', async (req, res) => {
    // 🌟 เปลี่ยนจาก 15m เป็น 1m เพื่อให้กราฟขึ้นไวๆ ถี่ยิบๆ
    const fluxQueryHistory = `
        from(bucket: "${bucket}")
        |> range(start: -24h)
        |> filter(fn: (r) => r["_measurement"] == "rain_sensor" or r["_measurement"] == "soil_sensor" or r["_measurement"] == "ec_sensor")
        |> filter(fn: (r) => r["_field"] == "value")
        |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
        |> yield(name: "mean")
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