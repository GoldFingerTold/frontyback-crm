require('dotenv').config();
const whatsapp = require('./server/services/whatsapp');

(async () => {
  try {
    const data = await whatsapp.enviarPlantilla({
      phoneNumberId: '1329760436894016',
      para: '541162195243', // sin el 9, probando el quirk conocido de numeros argentinos
      nombrePlantilla: 'turno_confirmacion',
      parametros: ['Hugo (debug)', 'Consulta de prueba', '14/10', '09:00']
    });
    console.log('respuesta completa de Meta:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('ERROR:', err.message);
  }
})();
