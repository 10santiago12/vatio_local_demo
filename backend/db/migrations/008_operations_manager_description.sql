-- 008: the operations manager reviews alerts and proposes actions; only the owner approves them.
-- (Migration 002 said it approves, which contradicts the permission matrix of the domain.)
UPDATE roles
   SET description = 'Revisa alertas, gestiona recomendaciones y propone acciones de control; la aprobación la da el administrador.'
 WHERE code = 'operations_manager';
