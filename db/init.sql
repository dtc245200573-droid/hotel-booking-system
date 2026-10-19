-- 1. Bảng Tài khoản (Đăng nhập / Đăng ký)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(100) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(20) DEFAULT 'CUSTOMER',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bảng Phòng
CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    room_number VARCHAR(20) UNIQUE NOT NULL,
    room_type VARCHAR(50) NOT NULL,
    price_per_night NUMERIC(12, 2) NOT NULL CHECK (price_per_night >= 0),
    floor INTEGER DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Bảng Khách hàng
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    full_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    id_card VARCHAR(30) UNIQUE NOT NULL,
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Bảng Đặt phòng
CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    total_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
    booking_status VARCHAR(20) DEFAULT 'CONFIRMED',
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(booking_status);

-- Tài khoản mẫu ban đầu
INSERT INTO users (username, password, full_name, phone, role) VALUES
('admin', 'admin123', 'Quản Trị Viên', '0909999999', 'ADMIN'),
('khachhang1', '123456', 'Nguyễn Văn An', '0901234567', 'CUSTOMER'),
('khachhang2', '123456', 'Trần Thị Bích Ngọc', '0912345678', 'CUSTOMER')
ON CONFLICT (username) DO NOTHING;

-- Phòng mẫu
INSERT INTO rooms (room_number, room_type, price_per_night, floor, status, description) VALUES
('101', 'Standard Single', 450000, 1, 'AVAILABLE', 'Phòng đơn tầng 1, wifi tốc độ cao'),
('102', 'Standard Single', 450000, 1, 'OCCUPIED', 'Phòng đơn tầng 1, view vườn yên tĩnh'),
('103', 'Standard Double', 650000, 1, 'AVAILABLE', 'Phòng đôi tiêu chuẩn, 1 giường lớn'),
('104', 'Standard Double', 650000, 1, 'MAINTENANCE', 'Đang bảo dưỡng điều hòa'),
('201', 'Superior City View', 850000, 2, 'AVAILABLE', 'Phòng cao cấp tầng 2 view thành phố'),
('202', 'Superior City View', 850000, 2, 'OCCUPIED', 'Phòng cao cấp tầng 2 có minibar'),
('203', 'Deluxe Ocean View', 1200000, 2, 'AVAILABLE', 'Phòng view biển trực diện, bồn tắm nằm'),
('301', 'Family Suite', 1800000, 3, 'AVAILABLE', 'Phòng gia đình 2 giường King'),
('401', 'Presidential VIP', 3500000, 4, 'AVAILABLE', 'Phòng Tổng thống hạng sang phục vụ 24/7')
ON CONFLICT (room_number) DO NOTHING;

-- Khách hàng mẫu
INSERT INTO customers (user_id, full_name, phone, email, id_card, address) VALUES
(2, 'Nguyễn Văn An', '0901234567', 'nguyenvanan@gmail.com', '079205001234', 'Quận 1, TP. HCM'),
(3, 'Trần Thị Bích Ngọc', '0912345678', 'bichngoc.tran@gmail.com', '079205005678', 'Cầu Giấy, Hà Nội'),
(NULL, 'Lê Hoàng Minh', '0987654321', 'hoangminh.le@gmail.com', '079205009999', 'Hải Châu, Đà Nẵng')
ON CONFLICT (id_card) DO NOTHING;

-- Đơn đặt phòng mẫu
INSERT INTO bookings (customer_id, room_id, check_in, check_out, total_price, booking_status, note) VALUES
(1, 2, CURRENT_DATE, CURRENT_DATE + INTERVAL '2 days', 900000, 'CHECKED_IN', 'Khách đang ở'),
(2, 6, CURRENT_DATE - INTERVAL '1 day', CURRENT_DATE + INTERVAL '2 days', 2550000, 'CHECKED_IN', 'Khách VIP'),
(3, 1, CURRENT_DATE - INTERVAL '4 days', CURRENT_DATE - INTERVAL '2 days', 900000, 'CHECKED_OUT', 'Đã thanh toán đủ');

-- Hardening DB: User read-only cho Prometheus
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'monitoring_user') THEN
        CREATE USER monitoring_user WITH PASSWORD 'Monitor_2026_ReadOnly99!';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE hotel_booking_db TO monitoring_user;
GRANT USAGE ON SCHEMA public TO monitoring_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO monitoring_user;
GRANT pg_monitor TO monitoring_user;
