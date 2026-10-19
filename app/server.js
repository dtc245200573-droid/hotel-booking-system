const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');
const path = require('path');

const app = express();
const PORT = process.env.APP_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// 1. CẤU HÌNH GHI LOG TẬP TRUNG (Loki + Promtail + LogQL)
// =========================================================
function writeLog(level, action, message, extra = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'hotel-web-app',
    action,
    message,
    ...extra
  };
  console.log(JSON.stringify(logEntry));
}

// =========================================================
// 2. CẤU HÌNH PROMETHEUS METRICS (Prometheus + Grafana)
// =========================================================
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'hotel_app_' });

const httpRequestCounter = new client.Counter({
  name: 'hotel_http_requests_total',
  help: 'Tong so luot HTTP request',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

const loginCounter = new client.Counter({
  name: 'hotel_logins_total',
  help: 'Tong so luot dang nhap',
  labelNames: ['status'], // success, failed
  registers: [register]
});

const registrationCounter = new client.Counter({
  name: 'hotel_registrations_total',
  help: 'Tong so tai khoan dang ky moi',
  registers: [register]
});

const bookingCounter = new client.Counter({
  name: 'hotel_bookings_created_total',
  help: 'Tong so don dat phong thanh cong',
  registers: [register]
});

const revenueGauge = new client.Gauge({
  name: 'hotel_total_revenue_vnd',
  help: 'Tong doanh thu khach san VND',
  registers: [register]
});

// Middleware đếm request & xuất log tự động
app.use((req, res, next) => {
  res.on('finish', () => {
    if (req.path !== '/metrics') {
      httpRequestCounter.inc({
        method: req.method,
        route: req.path,
        status: res.statusCode
      });
      writeLog('INFO', 'HTTP_REQUEST', `${req.method} ${req.path} - ${res.statusCode}`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ip: req.ip
      });
    }
  });
  next();
});

// Endpoint thu thập metrics cho Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// =========================================================
// 3. KẾT NỐI POSTGRESQL & HEALTHCHECK
// =========================================================
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres_db',
  port: process.env.DB_PORT || 5432,
  user: process.env.POSTGRES_USER || 'hotel_admin',
  password: process.env.POSTGRES_PASSWORD || 'KhachSan_2026_StrongPass99!',
  database: process.env.POSTGRES_DB || 'hotel_booking_db'
});

app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as current_time');
    res.json({ status: 'OK', db_connected: true, server_time: result.rows[0].current_time });
  } catch (err) {
    writeLog('ERROR', 'DB_HEALTH_CHECK', 'Khong the ket noi PostgreSQL', { error: err.message });
    res.status(500).json({ status: 'ERROR', db_connected: false, error: err.message });
  }
});

// =========================================================
// 4. API XÁC THỰC: ĐĂNG KÝ & ĐĂNG NHẬP (SINH LOG & METRICS)
// =========================================================
app.post('/api/auth/register', async (req, res) => {
  const { username, password, full_name, phone, id_card } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Vui lòng điền đủ tên đăng nhập, mật khẩu và họ tên' });
  }

  try {
    const userRes = await pool.query(
      'INSERT INTO users (username, password, full_name, phone, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, full_name, role',
      [username, password, full_name, phone || '', 'CUSTOMER']
    );
    const newUser = userRes.rows[0];

    if (id_card) {
      await pool.query(
        'INSERT INTO customers (user_id, full_name, phone, id_card) VALUES ($1, $2, $3, $4) ON CONFLICT (id_card) DO NOTHING',
        [newUser.id, full_name, phone || '', id_card]
      );
    }

    registrationCounter.inc();
    writeLog('INFO', 'AUTH_REGISTER_SUCCESS', `Nguoi dung moi dang ky thanh cong: ${username}`, {
      user_id: newUser.id,
      username,
      full_name
    });

    res.status(201).json({ message: 'Đăng ký thành công', user: newUser });
  } catch (err) {
    writeLog('WARN', 'AUTH_REGISTER_FAILED', `Dang ky that bai cho username: ${username}`, { error: err.message });
    res.status(400).json({ error: 'Tên đăng nhập hoặc số CCCD đã tồn tại trong hệ thống!' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, username, full_name, phone, role FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );

    if (result.rows.length === 0) {
      loginCounter.inc({ status: 'failed' });
      writeLog('WARN', 'AUTH_LOGIN_FAILED', `Dang nhap that bai cho username: ${username}`, {
        username,
        ip: req.ip
      });
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác!' });
    }

    const user = result.rows[0];
    loginCounter.inc({ status: 'success' });
    writeLog('INFO', 'AUTH_LOGIN_SUCCESS', `Nguoi dung ${username} dang nhap thanh cong`, {
      user_id: user.id,
      username: user.username,
      role: user.role,
      ip: req.ip
    });

    res.json({ message: 'Đăng nhập thành công', user });
  } catch (err) {
    writeLog('ERROR', 'AUTH_LOGIN_ERROR', err.message);
    res.status(500).json({ error: 'Lỗi máy chủ khi đăng nhập' });
  }
});

// =========================================================
// 5. API DASHBOARD THỐNG KÊ (Prometheus & UI)
// =========================================================
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const roomsStats = await pool.query(`
      SELECT 
        COUNT(*) AS total_rooms,
        COUNT(*) FILTER (WHERE status = 'AVAILABLE') AS available_rooms,
        COUNT(*) FILTER (WHERE status = 'OCCUPIED') AS occupied_rooms,
        COUNT(*) FILTER (WHERE status = 'MAINTENANCE') AS maintenance_rooms
      FROM rooms
    `);

    const customersCount = await pool.query('SELECT COUNT(*) AS total_customers FROM customers');
    const bookingsStats = await pool.query(`
      SELECT 
        COUNT(*) AS total_bookings,
        COALESCE(SUM(total_price) FILTER (WHERE booking_status != 'CANCELLED'), 0) AS total_revenue
      FROM bookings
    `);

    const totalRooms = parseInt(roomsStats.rows[0].total_rooms) || 0;
    const occupiedRooms = parseInt(roomsStats.rows[0].occupied_rooms) || 0;
    const occupancyRate = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;
    const totalRev = parseFloat(bookingsStats.rows[0].total_revenue) || 0;

    revenueGauge.set(totalRev);

    res.json({
      rooms: {
        total: totalRooms,
        available: parseInt(roomsStats.rows[0].available_rooms) || 0,
        occupied: occupiedRooms,
        maintenance: parseInt(roomsStats.rows[0].maintenance_rooms) || 0,
        occupancy_rate: occupancyRate
      },
      customers: parseInt(customersCount.rows[0].total_customers) || 0,
      bookings: parseInt(bookingsStats.rows[0].total_bookings) || 0,
      revenue: totalRev
    });
  } catch (err) {
    writeLog('ERROR', 'GET_STATS_FAILED', err.message);
    res.status(500).json({ error: 'Lỗi tải thống kê' });
  }
});

// =========================================================
// 6. API QUẢN LÝ PHÒNG (ROOMS)
// =========================================================
app.get('/api/rooms', async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM rooms';
    const params = [];
    if (status && status !== 'ALL') {
      params.push(status);
      query += ' WHERE status = $1';
    }
    query += ' ORDER BY room_number ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    writeLog('ERROR', 'GET_ROOMS_FAILED', err.message);
    res.status(500).json({ error: 'Lỗi tải danh sách phòng' });
  }
});

app.post('/api/rooms', async (req, res) => {
  const { room_number, room_type, price_per_night, floor, status, description } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO rooms (room_number, room_type, price_per_night, floor, status, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [room_number, room_type, price_per_night, floor || 1, status || 'AVAILABLE', description || '']
    );
    writeLog('INFO', 'ROOM_CREATED', `Them phong ${room_number}`, { room_number, room_type });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    writeLog('ERROR', 'CREATE_ROOM_FAILED', err.message, { room_number });
    res.status(400).json({ error: 'Không thể thêm phòng (số phòng đã tồn tại)' });
  }
});

app.put('/api/rooms/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const result = await pool.query('UPDATE rooms SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
    writeLog('INFO', 'ROOM_STATUS_CHANGED', `Doi trang thai phong #${id} sang ${status}`);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi cập nhật trạng thái phòng' });
  }
});

// =========================================================
// 7. API QUẢN LÝ KHÁCH HÀNG (CUSTOMERS)
// =========================================================
app.get('/api/customers', async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT * FROM customers';
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ' WHERE full_name ILIKE $1 OR phone ILIKE $1 OR id_card ILIKE $1';
    }
    query += ' ORDER BY id DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi tải danh sách khách hàng' });
  }
});

app.post('/api/customers', async (req, res) => {
  const { full_name, phone, email, id_card, address } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO customers (full_name, phone, email, id_card, address) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [full_name, phone, email, id_card, address || '']
    );
    writeLog('INFO', 'CUSTOMER_CREATED', `Them khach hang: ${full_name}`, { id_card, phone });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: 'Không thể thêm khách hàng (trùng số CCCD)' });
  }
});

// =========================================================
// 8. API QUẢN LÝ ĐẶT PHÒNG (BOOKINGS)
// =========================================================
app.get('/api/bookings', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT b.id, b.check_in, b.check_out, b.total_price, b.booking_status, b.note,
             c.full_name, c.phone, c.id_card,
             r.room_number, r.room_type, r.price_per_night
      FROM bookings b
      JOIN customers c ON b.customer_id = c.id
      JOIN rooms r ON b.room_id = r.id
    `;
    const params = [];
    if (status && status !== 'ALL') {
      params.push(status);
      query += ' WHERE b.booking_status = $1';
    }
    query += ' ORDER BY b.id DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi tải danh sách đặt phòng' });
  }
});

app.post('/api/bookings', async (req, res) => {
  const { customer_id, room_id, check_in, check_out, note } = req.body;
  try {
    const roomRes = await pool.query('SELECT price_per_night, room_number, status FROM rooms WHERE id = $1', [room_id]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'Phòng không tồn tại' });
    if (roomRes.rows[0].status === 'MAINTENANCE') {
      return res.status(400).json({ error: 'Phòng này đang bảo trì, vui lòng chọn phòng khác!' });
    }

    const price = parseFloat(roomRes.rows[0].price_per_night);
    const start = new Date(check_in);
    const end = new Date(check_out);
    const days = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
    const total_price = price * days;

    const bookingRes = await pool.query(
      'INSERT INTO bookings (customer_id, room_id, check_in, check_out, total_price, booking_status, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [customer_id, room_id, check_in, check_out, total_price, 'CONFIRMED', note || '']
    );

    await pool.query("UPDATE rooms SET status = 'OCCUPIED' WHERE id = $1", [room_id]);
    bookingCounter.inc();

    writeLog('INFO', 'BOOKING_SUCCESS', `Dat phong thanh cong: Phong ${roomRes.rows[0].room_number}`, {
      booking_id: bookingRes.rows[0].id,
      room_number: roomRes.rows[0].room_number,
      total_price,
      days
    });

    res.status(201).json(bookingRes.rows[0]);
  } catch (err) {
    writeLog('ERROR', 'BOOKING_FAILED', err.message);
    res.status(400).json({ error: 'Lỗi tạo đơn đặt phòng: ' + err.message });
  }
});

// Check-in (Nhận phòng)
app.put('/api/bookings/:id/checkin', async (req, res) => {
  const { id } = req.params;
  try {
    const updateRes = await pool.query(
      "UPDATE bookings SET booking_status = 'CHECKED_IN' WHERE id = $1 RETURNING *",
      [id]
    );
    if (updateRes.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn' });
    await pool.query("UPDATE rooms SET status = 'OCCUPIED' WHERE id = $1", [updateRes.rows[0].room_id]);
    writeLog('INFO', 'CHECKIN_SUCCESS', `Khach hang nhan phong don #${id}`);
    res.json(updateRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi nhận phòng' });
  }
});

// Check-out (Trả phòng)
app.put('/api/bookings/:id/checkout', async (req, res) => {
  const { id } = req.params;
  try {
    const updateRes = await pool.query(
      "UPDATE bookings SET booking_status = 'CHECKED_OUT' WHERE id = $1 RETURNING *",
      [id]
    );
    if (updateRes.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn' });
    await pool.query("UPDATE rooms SET status = 'AVAILABLE' WHERE id = $1", [updateRes.rows[0].room_id]);
    writeLog('INFO', 'CHECKOUT_SUCCESS', `Khach hang tra phong don #${id}, phong tro ve trang thai AVAILABLE`);
    res.json(updateRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi trả phòng' });
  }
});

// Hủy đặt phòng
app.put('/api/bookings/:id/cancel', async (req, res) => {
  const { id } = req.params;
  try {
    const updateRes = await pool.query(
      "UPDATE bookings SET booking_status = 'CANCELLED' WHERE id = $1 RETURNING *",
      [id]
    );
    if (updateRes.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn' });
    await pool.query("UPDATE rooms SET status = 'AVAILABLE' WHERE id = $1", [updateRes.rows[0].room_id]);
    writeLog('WARN', 'BOOKING_CANCELLED', `Don dat phong #${id} da bi huy`);
    res.json(updateRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi hủy đơn' });
  }
});

app.listen(PORT, () => {
  writeLog('INFO', 'SERVER_START', `He thong Dat phong Khach san dang chay tai port ${PORT}`);
});
