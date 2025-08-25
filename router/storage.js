// backend/router/storage.js
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../utils/postgres');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'seu-segredo-super-secreto-para-jwt';

// --- Middlewares ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token de acesso requerido' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido' });
        req.user = user;
        next();
    });
};

const requireMaster = (req, res, next) => {
    if (req.user.role !== 'master') {
        return res.status(403).json({ error: 'Acesso negado.' });
    }
    next();
};

// --- ROTAS PARA TIPOS DE PACOTE (PACKAGE TYPES) ---

// GET /api/storage/package-types - Listar todos os tipos de pacote
router.get('/package-types', authenticateToken, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT id, name, price FROM public.package_types ORDER BY name ASC');
        const formattedRows = rows.map(pt => ({ ...pt, price: parseFloat(pt.price) }));
        res.json(formattedRows);
    } catch (error) {
        console.error('Erro ao buscar tipos de pacote:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// POST /api/storage/package-types - Criar um novo tipo de pacote (master only)
router.post('/package-types', authenticateToken, requireMaster, async (req, res) => {
    const { name, price } = req.body;
    if (!name || price == null) {
        return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
    }
    try {
        const { rows } = await db.query(
            'INSERT INTO public.package_types (name, price) VALUES ($1, $2) RETURNING *',
            [name, parseFloat(price)]
        );
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Erro ao criar tipo de pacote:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// PUT /api/storage/package-types/:id - Atualizar um tipo de pacote (master only)
router.put('/package-types/:id', authenticateToken, requireMaster, async (req, res) => {
    const { id } = req.params;
    const { name, price } = req.body;
    if (!name || price == null) {
        return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
    }
    try {
        const { rows } = await db.query(
            'UPDATE public.package_types SET name = $1, price = $2 WHERE id = $3 RETURNING *',
            [name, parseFloat(price), id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Tipo de pacote não encontrado.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao atualizar tipo de pacote:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});

// DELETE /api/storage/package-types/:id - Deletar um tipo de pacote (master only)
router.delete('/package-types/:id', authenticateToken, requireMaster, async (req, res) => {
    const { id } = req.params;
    try {
        const { rowCount } = await db.query('DELETE FROM public.package_types WHERE id = $1', [id]);
        if (rowCount === 0) {
            return res.status(404).json({ error: 'Tipo de pacote não encontrado.' });
        }
        res.status(200).json({ message: 'Tipo de pacote excluído com sucesso.' });
    } catch (error) {
        console.error('Erro ao deletar tipo de pacote:', error);
        if (error.code === '23503') { // foreign key violation
            return res.status(400).json({ error: 'Não é possível excluir. Este tipo de pacote está em uso por um ou mais SKUs.' });
        }
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});


// --- ROTA DE CÁLCULO DE FATURAMENTO DE ARMAZENAMENTO ---
router.get('/user/:userId/billing-summary', authenticateToken, requireMaster, async (req, res) => {
    const { userId } = req.params;
    try {
        // 1. Busca os preços MESTRE diretamente da tabela de serviços.
        const masterPricesQuery = `SELECT type, price FROM public.services WHERE type IN ('base_storage', 'additional_storage');`;
        const masterPricesResult = await db.query(masterPricesQuery);
        const masterPrices = masterPricesResult.rows.reduce((acc, service) => {
            acc[service.type] = parseFloat(service.price);
            return acc;
        }, {});

        const masterBasePrice = masterPrices['base_storage'] || 0;
        const masterAdditionalPrice = masterPrices['additional_storage'] || 0;

        // 2. Busca os contratos do usuário para saber O QUE ele contratou.
        const contractsQuery = `
            SELECT s.type, uc.volume
            FROM public.user_contracts uc
            JOIN public.services s ON uc.service_id = s.id
            WHERE uc.uid = $1 AND s.type IN ('base_storage', 'additional_storage');
        `;
        const contractsResult = await db.query(contractsQuery, [userId]);
        
        let totalCost = 0, baseCost = 0, additionalCost = 0, additionalVolume = 0;

        const baseService = contractsResult.rows.find(c => c.type === 'base_storage');
        if (baseService) {
            baseCost = masterBasePrice;
        }

        const additionalServiceContract = contractsResult.rows.find(c => c.type === 'additional_storage');
        if (additionalServiceContract) {
            const quantity = parseInt(additionalServiceContract.volume, 10) || 0;
            additionalCost = masterAdditionalPrice * quantity;
            additionalVolume = quantity;
        }

        totalCost = baseCost + additionalCost;

        const volumeQuery = `
            SELECT COALESCE(SUM((s.dimensoes->>'altura')::numeric * (s.dimensoes->>'largura')::numeric * (s.dimensoes->>'comprimento')::numeric / 1000000 * s.quantidade), 0) as total_volume
            FROM public.skus s
            WHERE s.user_id = $1;
        `;
        const volumeResult = await db.query(volumeQuery, [userId]);
        const consumedVolume = parseFloat(volumeResult.rows[0].total_volume);

        // 3. NOVO: CÁLCULO DE CUSTO DE EXPEDIÇÃO PARA O MÊS ATUAL
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth(); // 0-11
        const startDate = new Date(Date.UTC(year, month, 1));
        const endDate = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, -1));

        const shipmentsQuery = `
            SELECT sm.quantity_change, pt.name as package_type_name, pt.price as package_type_price
            FROM public.stock_movements sm
            JOIN public.skus s ON sm.sku_id = s.id
            JOIN public.package_types pt ON s.package_type_id = pt.id
            WHERE sm.user_id = $1
              AND sm.movement_type = 'saida'
              AND sm.reason LIKE 'Saída por Venda%'
              AND sm.created_at BETWEEN $2 AND $3;
        `;
        const shipmentsResult = await db.query(shipmentsQuery, [userId, startDate, endDate]);
        
        let expedicaoComumCost = 0;
        let expedicaoPremiumCost = 0;

        for (const shipment of shipmentsResult.rows) {
            if (shipment.package_type_name === 'Expedição Comum') {
                expedicaoComumCost += shipment.quantity_change * parseFloat(shipment.package_type_price);
            } else if (shipment.package_type_name === 'Expedição Premium') {
                expedicaoPremiumCost += shipment.quantity_change * parseFloat(shipment.package_type_price);
            }
        }

        // Adiciona os custos de expedição ao custo total
        totalCost += expedicaoComumCost + expedicaoPremiumCost;

        res.json({ 
            consumedVolume, 
            baseCost, 
            additionalVolume, 
            additionalCost, 
            expedicaoComumCost, 
            expedicaoPremiumCost,
            totalCost 
        });

    } catch (error) {
        console.error('Erro ao calcular faturamento de armazenamento:', error);
        res.status(500).json({ error: 'Erro interno ao calcular faturamento.' });
    }
});


// --- ROTAS DE GERENCIAMENTO DE SKU ---

// GET /api/storage/user/:userId/available-child-skus - Get SKUs that can be used as kit components
router.get('/user/:userId/available-child-skus', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    
    // Allow masters and the user themselves to access their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }
    try {
        const query = `
            SELECT id, sku, descricao, quantidade
            FROM public.skus
            WHERE user_id = $1 AND is_kit = false
            ORDER BY sku ASC
        `;
        const { rows } = await db.query(query, [userId]);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar SKUs disponíveis para kit:', error);
        res.status(500).json({ error: 'Erro interno ao buscar SKUs.' });
    }
});

router.get('/user/:userId/skus', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    
    // Allow masters and the user themselves to access their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }
    try {
        const query = `
            SELECT 
                s.id, s.user_id, s.sku, s.descricao, s.dimensoes, s.quantidade, s.package_type_id, s.kit_parent_id, s.is_kit,
                pt.name as package_type_name, pt.price as package_type_price,
                kp.nome as kit_parent_name
            FROM public.skus s
            LEFT JOIN public.package_types pt ON s.package_type_id = pt.id
            LEFT JOIN public.kit_parents kp ON s.kit_parent_id = kp.id
            WHERE s.user_id = $1 
            ORDER BY s.is_kit ASC, s.created_at DESC
        `;
        const { rows } = await db.query(query, [userId]);
        
        // Get kit components for all kit SKUs
        const kitComponentsQuery = `
            SELECT 
                kc.kit_sku_id,
                kc.child_sku_id,
                kc.quantity_per_kit,
                cs.sku as child_sku_code,
                cs.descricao as child_descricao,
                cs.quantidade as child_stock
            FROM public.sku_kit_components kc
            JOIN public.skus cs ON kc.child_sku_id = cs.id
            WHERE kc.kit_sku_id IN (SELECT id FROM public.skus WHERE user_id = $1 AND is_kit = true)
        `;
        const kitComponentsResult = await db.query(kitComponentsQuery, [userId]);
        
        // Group kit components by kit_sku_id
        const kitComponentsMap = {};
        kitComponentsResult.rows.forEach(row => {
            if (!kitComponentsMap[row.kit_sku_id]) {
                kitComponentsMap[row.kit_sku_id] = [];
            }
            kitComponentsMap[row.kit_sku_id].push({
                child_sku_id: row.child_sku_id,
                child_sku_code: row.child_sku_code,
                child_descricao: row.child_descricao,
                child_stock: row.child_stock,
                quantity_per_kit: row.quantity_per_kit
            });
        });
        
        const skus = rows.map(sku => {
            const result = {
                ...sku,
                dimensoes: typeof sku.dimensoes === 'string' ? JSON.parse(sku.dimensoes) : sku.dimensoes,
                package_type_price: sku.package_type_price ? parseFloat(sku.package_type_price) : null
            };
            
            // Add kit components if this is a kit
            if (sku.is_kit && kitComponentsMap[sku.id]) {
                result.kit_components = kitComponentsMap[sku.id];
                // Calculate available kit quantity based on child stock
                result.available_kit_quantity = result.kit_components.reduce((min, component) => {
                    const availableFromChild = Math.floor(component.child_stock / component.quantity_per_kit);
                    return Math.min(min, availableFromChild);
                }, Infinity);
                if (result.available_kit_quantity === Infinity) result.available_kit_quantity = 0;
            }
            
            return result;
        });
        
        res.json(skus);
    } catch (error) {
        console.error('Erro ao buscar SKUs do usuário:', error);
        res.status(500).json({ error: 'Erro interno ao buscar SKUs.' });
    }
});

router.post('/user/:userId/skus', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    const { sku, descricao, dimensoes, quantidade, package_type_id, kit_parent_id, is_kit, kit_components } = req.body;
    
    // Allow masters and the user themselves to manage their own data
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!sku || !descricao || !dimensoes) {
        return res.status(400).json({ error: 'Campos de SKU, descrição e dimensões são obrigatórios.' });
    }

    // For kits, quantidade should be 0 and kit_components should be provided
    if (is_kit) {
        if (!kit_components || !Array.isArray(kit_components) || kit_components.length === 0) {
            return res.status(400).json({ error: 'Kit deve ter pelo menos um componente filho.' });
        }
        
        // Validate kit components
        for (const component of kit_components) {
            if (!component.child_sku_id || !component.quantity_per_kit || component.quantity_per_kit <= 0) {
                return res.status(400).json({ error: 'Todos os componentes do kit devem ter SKU filho e quantidade válidos.' });
            }
        }
    } else {
        if (quantidade == null || quantidade < 0) {
            return res.status(400).json({ error: 'Quantidade é obrigatória para SKUs normais.' });
        }
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Insert the main SKU
        const insertSkuQuery = `
            INSERT INTO public.skus (user_id, sku, descricao, dimensoes, quantidade, package_type_id, kit_parent_id, is_kit)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
        `;
        const finalQuantidade = is_kit ? 0 : quantidade;
        const skuResult = await client.query(insertSkuQuery, [userId, sku, descricao, JSON.stringify(dimensoes), finalQuantidade, package_type_id || null, kit_parent_id || null, is_kit || false]);
        const newSkuId = skuResult.rows[0].id;

        // If it's a kit, insert the kit components
        if (is_kit && kit_components && kit_components.length > 0) {
            for (const component of kit_components) {
                // Verify that the child SKU exists and belongs to the same user
                const childSkuCheck = await client.query(
                    'SELECT id FROM public.skus WHERE id = $1 AND user_id = $2 AND is_kit = false',
                    [component.child_sku_id, userId]
                );
                
                if (childSkuCheck.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: `SKU filho com ID ${component.child_sku_id} não encontrado ou é um kit.` });
                }
                
                const insertComponentQuery = `
                    INSERT INTO public.sku_kit_components (kit_sku_id, child_sku_id, quantity_per_kit)
                    VALUES ($1, $2, $3)
                `;
                await client.query(insertComponentQuery, [newSkuId, component.child_sku_id, component.quantity_per_kit]);
            }
        }

        // Add initial stock movement for non-kit SKUs
        if (!is_kit && quantidade > 0) {
            const insertMovementQuery = `
                INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason)
                VALUES ($1, $2, 'entrada', $3, 'Entrada inicial de estoque');
            `;
            await client.query(insertMovementQuery, [newSkuId, userId, quantidade]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: is_kit ? 'Kit criado com sucesso' : 'SKU adicionado com sucesso', skuId: newSkuId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao adicionar novo SKU:', error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Este código SKU já existe para este usuário.' });
        }
        res.status(500).json({ error: 'Erro interno ao adicionar SKU.' });
    } finally {
        client.release();
    }
});

router.put('/skus/:skuId', authenticateToken, async (req, res) => {
    const { skuId } = req.params;
    const { descricao, dimensoes, package_type_id, kit_parent_id } = req.body;
    
    // Verify that the SKU belongs to the user or they are master
    const skuOwnerCheck = await db.query('SELECT user_id FROM public.skus WHERE id = $1', [skuId]);
    if (skuOwnerCheck.rows.length === 0) {
        return res.status(404).json({ error: 'SKU não encontrado.' });
    }
    
    const skuOwnerId = skuOwnerCheck.rows[0].user_id;
    if (req.user.role !== 'master' && req.user.uid !== skuOwnerId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!descricao || !dimensoes) {
        return res.status(400).json({ error: 'Descrição e dimensões são obrigatórios.' });
    }

    try {
        const query = `
            UPDATE public.skus
            SET descricao = $1, dimensoes = $2, package_type_id = $3, kit_parent_id = $4, updated_at = NOW()
            WHERE id = $5
            RETURNING *;
        `;
        const { rows } = await db.query(query, [descricao, JSON.stringify(dimensoes), package_type_id || null, kit_parent_id || null, skuId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'SKU não encontrado.' });
        }
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao atualizar SKU:', error);
        res.status(500).json({ error: 'Erro interno ao atualizar SKU.' });
    }
});

router.delete('/skus/:skuId', authenticateToken, requireMaster, async (req, res) => {
    const { skuId } = req.params;
    const client = await db.pool.connect(); 

    try {
        await client.query('BEGIN');

        const skuCheck = await client.query('SELECT quantidade FROM public.skus WHERE id = $1 FOR UPDATE', [skuId]);

        if (skuCheck.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'SKU não encontrado.' });
        }

        if (skuCheck.rows[0].quantidade > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Não é possível excluir SKU com estoque positivo. Zere o estoque primeiro.' });
        }

        await client.query('DELETE FROM public.stock_movements WHERE sku_id = $1', [skuId]);
        const { rowCount } = await client.query('DELETE FROM public.skus WHERE id = $1', [skuId]);

        if (rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Falha ao excluir o SKU após limpar o histórico.' });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'SKU e seu histórico foram excluídos com sucesso.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao deletar SKU:', error);
        if (error.code === '23503') {
            return res.status(400).json({ error: 'Não é possível excluir. O SKU está sendo referenciado em outra parte do sistema.' });
        }
        res.status(500).json({ error: 'Erro interno ao deletar SKU.' });
    } finally {
        client.release();
    }
});


// --- ROTAS DE MOVIMENTAÇÃO DE ESTOQUE ---

router.get('/user/:userId/movements', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    if (req.user.role !== 'master' && req.user.uid !== userId) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }
    try {
        const query = `
            SELECT 
                sm.id, s.sku, sm.movement_type, sm.quantity_change, sm.reason, 
                sm.related_sale_id, sm.created_at
            FROM public.stock_movements sm
            JOIN public.skus s ON sm.sku_id = s.id
            WHERE sm.user_id = $1
            ORDER BY sm.created_at DESC
        `;
        const { rows } = await db.query(query, [userId]);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar todas as movimentações do usuário:', error);
        res.status(500).json({ error: 'Erro interno ao buscar movimentações.' });
    }
});


router.get('/sku/:skuCode/movements', authenticateToken, requireMaster, async (req, res) => {
    const { skuCode } = req.params;
    const { uid } = req.query;

    if (!uid) return res.status(400).json({ error: 'UID do usuário é obrigatório.' });

    try {
        const query = `
            SELECT sm.id, sm.movement_type, sm.quantity_change, sm.reason, sm.related_sale_id, sm.created_at
            FROM public.stock_movements sm
            JOIN public.skus s ON sm.sku_id = s.id
            WHERE s.sku = $1 AND sm.user_id = $2
            ORDER BY sm.created_at DESC
        `;
        const { rows } = await db.query(query, [skuCode, uid]);
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar histórico do SKU:', error);
        res.status(500).json({ error: 'Erro interno ao buscar histórico.' });
    }
});

router.post('/sku/:skuCode/movements', authenticateToken, requireMaster, async (req, res) => {
    const { skuCode } = req.params;
    const { userId, movementType, quantityChange, reason, relatedSaleId } = req.body;

    if (!userId || !movementType || !quantityChange || !reason) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const findSkuQuery = 'SELECT id, quantidade, is_kit FROM public.skus WHERE sku = $1 AND user_id = $2 FOR UPDATE';
        const skuFound = await client.query(findSkuQuery, [skuCode, userId]);

        if (skuFound.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'SKU não encontrado ou pertence a outro usuário.' });
        }
        const { id: skuId, quantidade: currentQuantity, is_kit } = skuFound.rows[0];

        // If this is a kit and it's a sale (saida), we need to deduct from child SKUs
        if (is_kit && movementType === 'saida') {
            // Get kit components
            const kitComponentsQuery = `
                SELECT child_sku_id, quantity_per_kit
                FROM public.sku_kit_components
                WHERE kit_sku_id = $1
            `;
            const kitComponents = await client.query(kitComponentsQuery, [skuId]);

            if (kitComponents.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Kit não possui componentes filhos configurados.' });
            }

            // Check if we have enough stock of all child SKUs
            for (const component of kitComponents.rows) {
                const childSkuQuery = 'SELECT id, sku, quantidade FROM public.skus WHERE id = $1 FOR UPDATE';
                const childSku = await client.query(childSkuQuery, [component.child_sku_id]);
                
                if (childSku.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'SKU filho não encontrado.' });
                }
                
                const requiredQuantity = component.quantity_per_kit * quantityChange;
                if (childSku.rows[0].quantidade < requiredQuantity) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ 
                        error: `Estoque insuficiente do SKU filho ${childSku.rows[0].sku}. Disponível: ${childSku.rows[0].quantidade}, Necessário: ${requiredQuantity}` 
                    });
                }
            }

            // Deduct from child SKUs
            for (const component of kitComponents.rows) {
                const requiredQuantity = component.quantity_per_kit * quantityChange;
                
                // Update child SKU quantity
                const updateChildQuery = `
                    UPDATE public.skus SET quantidade = quantidade - $1, updated_at = NOW() WHERE id = $2;
                `;
                await client.query(updateChildQuery, [requiredQuantity, component.child_sku_id]);
                
                // Record movement for child SKU
                const insertChildMovementQuery = `
                    INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
                    VALUES ($1, $2, 'saida', $3, $4, $5);
                `;
                await client.query(insertChildMovementQuery, [
                    component.child_sku_id, 
                    userId, 
                    requiredQuantity, 
                    `Saída por Kit: ${reason}`, 
                    relatedSaleId || null
                ]);
            }

            // Record movement for the kit itself (informational)
            const insertKitMovementQuery = `
                INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
            `;
            await client.query(insertKitMovementQuery, [skuId, userId, movementType, quantityChange, reason, relatedSaleId || null]);
        } else {
            // Regular SKU movement logic
            const finalQuantityChange = movementType === 'entrada' ? quantityChange : -quantityChange;

            if (movementType === 'saida' && currentQuantity < quantityChange) {
                console.warn(`Alerta: Estoque do SKU ${skuCode} ficará negativo. Estoque atual: ${currentQuantity}, Saída: ${quantityChange}`);
            }

            const updateSkuQuery = `
                UPDATE public.skus SET quantidade = quantidade + $1, updated_at = NOW() WHERE id = $2;
            `;
            await client.query(updateSkuQuery, [finalQuantityChange, skuId]);

            const insertMovementQuery = `
                INSERT INTO public.stock_movements (sku_id, user_id, movement_type, quantity_change, reason, related_sale_id)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
            `;
            await client.query(insertMovementQuery, [skuId, userId, movementType, quantityChange, reason, relatedSaleId || null]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Movimentação registrada com sucesso.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao registrar ajuste de estoque:', error);
        res.status(500).json({ error: 'Erro interno ao ajustar estoque.' });
    } finally {
        client.release();
    }
});

module.exports = router;
