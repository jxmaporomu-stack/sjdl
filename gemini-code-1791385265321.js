require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const { TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const DB_FILE = './db.json';
const EPH = MessageFlags.Ephemeral;

/* ───────────── 데이터 저장 (JSON) ───────────── */
const defaultDB = {
  nextId: 1,
  nextChargeId: 1,
  charges: {},  // id: { id, userId, amount, depositor, imageUrl, status, handledBy }
  products: {}, // id: { id, name, price, stock: [string] }
  users: {},    // uid: { balance, checkInAt, lastRewardDate, totalMinutes }
  settings: { globalDiscount: 0, roleDiscounts: {}, buyerRoleId: null, attendReward: 100, bank: null, chargeChannelId: null },
};
let db = defaultDB;
if (fs.existsSync(DB_FILE)) {
  db = { ...defaultDB, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  db.settings = { ...defaultDB.settings, ...db.settings };
}
db.sessions ??= {}; // channelId: { userId, amount, depositor, createdAt, busy }
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const getUser = (id) => (db.users[id] ??= { balance: 0, checkInAt: null, lastRewardDate: null, totalMinutes: 0 });
const kstDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const won = (n) => `${n.toLocaleString()}P`;

/* 할인율: 전체 할인과 보유 역할 할인 중 가장 큰 값 1개만 적용 (중복 적용 X) */
function getDiscount(member) {
  let pct = db.settings.globalDiscount;
  for (const [rid, p] of Object.entries(db.settings.roleDiscounts)) {
    if (member.roles.cache.has(rid) && p > pct) pct = p;
  }
  return pct;
}
const finalPrice = (price, pct) => Math.floor((price * (100 - pct)) / 100);

/* ───────────── 슬래시 명령어 정의 ───────────── */
const admin = PermissionFlagsBits.Administrator;
const productOpt = (o) => o.setName('상품').setDescription('상품').setAutocomplete(true).setRequired(true);
const commands = [
  new SlashCommandBuilder().setName('상품추가').setDescription('상품 등록 (관리자)')
    .addStringOption((o) => o.setName('이름').setDescription('상품 이름').setRequired(true))
    .addIntegerOption((o) => o.setName('가격').setDescription('가격(포인트)').setMinValue(0).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('상품삭제').setDescription('상품 삭제 (관리자)')
    .addStringOption(productOpt).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('재고추가').setDescription('재고 추가 - 한 줄에 상품 1개 (관리자)')
    .addStringOption(productOpt).setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('상품목록').setDescription('상품/재고 현황 (관리자)')
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('자판기설치').setDescription('현재 채널에 자판기 메시지 설치 (관리자)')
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('전체할인').setDescription('전체 할인율 설정 (관리자)')
    .addIntegerOption((o) => o.setName('퍼센트').setDescription('0~100 (0이면 해제)').setMinValue(0).setMaxValue(100).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('역할할인').setDescription('특정 역할 할인율 설정 (관리자)')
    .addRoleOption((o) => o.setName('역할').setDescription('할인 받을 역할').setRequired(true))
    .addIntegerOption((o) => o.setName('퍼센트').setDescription('0~100 (0이면 해제)').setMinValue(0).setMaxValue(100).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('구매자역할').setDescription('구매 시 지급할 역할 설정 (관리자)')
    .addRoleOption((o) => o.setName('역할').setDescription('구매자 역할').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('잔액지급').setDescription('유저에게 포인트 지급/차감 (관리자)')
    .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
    .addIntegerOption((o) => o.setName('금액').setDescription('음수면 차감').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('출근보상').setDescription('하루 첫 출근 보상 포인트 설정 (관리자)')
    .addIntegerOption((o) => o.setName('금액').setDescription('포인트').setMinValue(0).setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('계좌설정').setDescription('충전용 입금 계좌 설정 (관리자)')
    .addStringOption((o) => o.setName('은행').setDescription('은행명').setRequired(true))
    .addStringOption((o) => o.setName('계좌번호').setDescription('계좌번호').setRequired(true))
    .addStringOption((o) => o.setName('예금주').setDescription('예금주').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('충전채널').setDescription('충전 요청이 올라올 관리자 채널 설정 (관리자)')
    .addChannelOption((o) => o.setName('채널').setDescription('관리자만 볼 수 있는 채널').setRequired(true))
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('충전안내').setDescription('입금 계좌 및 이중창 인증 방법 보기'),
  new SlashCommandBuilder().setName('충전패널').setDescription('현재 채널에 충전 신청 버튼 설치 (관리자)')
    .setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName('잔액').setDescription('내 포인트 확인'),
  new SlashCommandBuilder().setName('출근').setDescription('출근하기'),
  new SlashCommandBuilder().setName('퇴근').setDescription('퇴근하기'),
].map((c) => c.toJSON());

/* ───────────── 클라이언트 ───────────── */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('clientReady', async () => {
  const tokenToUse = TOKEN || 'MTU1NzQwNjUyOTg5MDgxMTkyNA.Glk0QO.uMHDy5WpknfeLJnvaMNqV9uajQ9OlIcg7TbH3o';
  const rest = new REST({ version: '10' }).setToken(tokenToUse);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`✅ ${client.user.tag} 로그인 / 명령어 등록 완료`);
});

function vendingPanel() {
  const products = Object.values(db.products).slice(0, 25);
  const embed = new EmbedBuilder().setTitle('🛒 자판기').setColor(0x5865f2)
    .setDescription(products.length
      ? products.map((p) => `**${p.name}** — ${won(p.price)} (재고 ${p.stock.length})`).join('\n')
      : '등록된 상품이 없습니다.')
    .setFooter({ text: '아래 메뉴에서 상품을 선택하세요. 할인은 구매 단계에서 자동 적용됩니다.' });
  const rows = [];
  if (products.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('vend_select').setPlaceholder('상품을 선택하세요')
        .addOptions(products.map((p) => ({
          label: p.name.slice(0, 100), description: `${won(p.price)} / 재고 ${p.stock.length}`, value: p.id,
        }))),
    ));
  }
  return { embeds: [embed], components: rows };
}

/* ───────────── 구매 처리 ───────────── */
async function purchase(interaction, productId) {
  const product = db.products[productId];
  if (!product) return interaction.editReply('존재하지 않는 상품입니다.');
  if (!product.stock.length) return interaction.editReply('❌ 품절된 상품입니다.');

  const user = getUser(interaction.user.id);
  const pct = getDiscount(interaction.member);
  const price = finalPrice(product.price, pct);
  if (user.balance < price) {
    return interaction.editReply(`❌ 포인트가 부족합니다. (필요 ${won(price)} / 보유 ${won(user.balance)})`);
  }

  // 결제 + 재고 차감 (여기까지 await 없음 → 동시 구매에도 안전)
  const item = product.stock.shift();
  user.balance -= price;
  save();

  // DM 발송, 실패 시 전액 환불 + 재고 복구
  try {
    await interaction.user.send({
      embeds: [new EmbedBuilder().setTitle('📦 구매 상품 도착').setColor(0x57f287)
        .addFields(
          { name: '상품', value: product.name },
          { name: '